import { Boom } from '@hapi/boom';
import { randomUUID, randomBytes } from 'crypto';
import { zip } from 'fflate';
import { promises as fs } from 'fs';
import {} from 'stream';
import { proto } from '../../WAProto/index.js';
import { CALL_AUDIO_PREFIX, CALL_VIDEO_PREFIX, MEDIA_KEYS, URL_REGEX, WA_DEFAULT_EPHEMERAL } from '../Defaults/index.js';
import { WAMessageStatus, WAProto } from '../Types/index.js';
import { isJidGroup, isJidNewsletter, isJidStatusBroadcast, jidNormalizedUser } from '../WABinary/index.js';
import { sha256 } from './crypto.js';
import { generateMessageIDV2, getKeyAuthor, unixTimestampSeconds } from './generics.js';
import { downloadContentFromMessage, encryptedStream, generateThumbnail, getAudioDuration, getAudioWaveform, getRawMediaUploadData } from './messages-media.js';
import { shouldIncludeReportingToken } from './reporting-utils.js';
import { tokenizeCode as tokenizeRichCode } from './message-composer.js';
const MIMETYPE_MAP = {
    image: 'image/jpeg',
    video: 'video/mp4',
    document: 'application/pdf',
    audio: 'audio/ogg; codecs=opus',
    sticker: 'image/webp',
    'product-catalog-image': 'image/jpeg'
};
const MessageTypeProto = {
    image: WAProto.Message.ImageMessage,
    video: WAProto.Message.VideoMessage,
    audio: WAProto.Message.AudioMessage,
    sticker: WAProto.Message.StickerMessage,
    document: WAProto.Message.DocumentMessage
};
const ButtonType = proto.Message.ButtonsMessage.HeaderType;
/**
 * Uses a regex to test whether the string contains a URL, and returns the URL if it does.
 * @param text eg. hello https://google.com
 * @returns the URL, eg. https://google.com
 */
export const extractUrlFromText = (text) => text.match(URL_REGEX)?.[0];
export const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
    const url = extractUrlFromText(text);
    if (!!getUrlInfo && url) {
        try {
            const urlInfo = await getUrlInfo(url);
            return urlInfo;
        }
        catch (error) {
            // ignore if fails
            logger?.warn({ trace: error.stack }, 'url generation failed');
        }
    }
};
const assertColor = async (color) => {
    if (typeof color === 'number' && Number.isFinite(color)) {
        return color >>> 0;
    }
    if (typeof color !== 'string') {
        throw new Boom('Color must be a number or hexadecimal string', { statusCode: 400 });
    }
    let hex = color.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{1,8}$/.test(hex)) {
        throw new Boom('Invalid hexadecimal color', { statusCode: 400 });
    }
    if (hex.length <= 6) {
        hex = `FF${hex.padStart(6, '0')}`;
    }
    return Number.parseInt(hex, 16) >>> 0;
}
export const prepareWAMessageMedia = async (message, options) => {
    const logger = options.logger;
    let mediaType;
    for (const key of MEDIA_KEYS) {
        if (key in message) {
            mediaType = key;
        }
    }
    if (!mediaType) {
        throw new Boom('Invalid media type', { statusCode: 400 });
    }
    const uploadData = {
        ...message,
        media: message[mediaType]
    };
    delete uploadData[mediaType];
    // check if cacheable + generate cache key
    const cacheableKey = typeof uploadData.media === 'object' &&
        'url' in uploadData.media &&
        !!uploadData.media.url &&
        !!options.mediaCache &&
        mediaType + ':' + uploadData.media.url.toString();
    if (mediaType === 'document' && !uploadData.fileName) {
        uploadData.fileName = 'file';
    }
    if (!uploadData.mimetype) {
        uploadData.mimetype = MIMETYPE_MAP[mediaType];
    }
    if (cacheableKey) {
        const mediaBuff = await options.mediaCache.get(cacheableKey);
        if (mediaBuff) {
            logger?.debug({ cacheableKey }, 'got media cache hit');
            const obj = proto.Message.decode(mediaBuff);
            const key = `${mediaType}Message`;
            Object.assign(obj[key], { ...uploadData, media: undefined });
            return obj;
        }
    }
    const isNewsletter = !!options.jid && isJidNewsletter(options.jid);
    if (isNewsletter) {
        logger?.info({ key: cacheableKey }, 'Preparing raw media for newsletter');
        const { filePath, fileSha256, fileLength } = await getRawMediaUploadData(uploadData.media, options.mediaTypeOverride || mediaType, logger);
        const fileSha256B64 = fileSha256.toString('base64');
        const { mediaUrl, directPath } = await options.upload(filePath, {
            fileEncSha256B64: fileSha256B64,
            mediaType: mediaType,
            timeoutMs: options.mediaUploadTimeoutMs
        });
        await fs.unlink(filePath);
        const obj = WAProto.Message.fromObject({
            // todo: add more support here
            [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
                url: mediaUrl,
                directPath,
                fileSha256,
                fileLength,
                ...uploadData,
                media: undefined
            })
        });
        if (uploadData.ptv) {
            obj.ptvMessage = obj.videoMessage;
            delete obj.videoMessage;
        }
        if (obj.stickerMessage) {
            obj.stickerMessage.stickerSentTs = Date.now();
        }
        if (cacheableKey) {
            logger?.debug({ cacheableKey }, 'set cache');
            await options.mediaCache.set(cacheableKey, WAProto.Message.encode(obj).finish());
        }
        return obj;
    }
    const requiresDurationComputation = mediaType === 'audio' && typeof uploadData.seconds === 'undefined';
    const requiresThumbnailComputation = (mediaType === 'image' || mediaType === 'video') && typeof uploadData['jpegThumbnail'] === 'undefined';
    const requiresWaveformProcessing = mediaType === 'audio' && uploadData.ptt === true && typeof uploadData.waveform === 'undefined';
    const requiresAudioBackground = options.backgroundColor && mediaType === 'audio' && uploadData.ptt === true;
    const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation;
    const { mediaKey, encFilePath, originalFilePath, fileEncSha256, fileSha256, fileLength } = await encryptedStream(uploadData.media, options.mediaTypeOverride || mediaType, {
        logger,
        saveOriginalFileIfRequired: requiresOriginalForSomeProcessing,
        opts: options.options
    });
    const fileEncSha256B64 = fileEncSha256.toString('base64');
    const [{ mediaUrl, directPath }] = await Promise.all([
        (async () => {
            const result = await options.upload(encFilePath, {
                fileEncSha256B64,
                mediaType,
                timeoutMs: options.mediaUploadTimeoutMs
            });
            logger?.debug({ mediaType, cacheableKey }, 'uploaded media');
            return result;
        })(),
        (async () => {
            try {
                if (requiresThumbnailComputation) {
                    const { thumbnail, originalImageDimensions } = await generateThumbnail(originalFilePath, mediaType, options);
                    uploadData.jpegThumbnail = thumbnail;
                    if (!uploadData.width && originalImageDimensions) {
                        uploadData.width = originalImageDimensions.width;
                        uploadData.height = originalImageDimensions.height;
                        logger?.debug('set dimensions');
                    }
                    logger?.debug('generated thumbnail');
                }
                if (requiresDurationComputation) {
                    uploadData.seconds = await getAudioDuration(originalFilePath);
                    logger?.debug('computed audio duration');
                }
                if (requiresWaveformProcessing) {
                    uploadData.waveform = await getAudioWaveform(originalFilePath, logger);
                    logger?.debug('processed waveform');
                }
                if (requiresAudioBackground) {
                    uploadData.backgroundArgb = await assertColor(options.backgroundColor);
                    logger?.debug('computed backgroundColor audio status');
                }
            }
            catch (error) {
                logger?.warn({ trace: error.stack }, 'failed to obtain extra info');
            }
        })()
    ]).finally(async () => {
        try {
            await fs.unlink(encFilePath);
            if (originalFilePath) {
                await fs.unlink(originalFilePath);
            }
            logger?.debug('removed tmp files');
        }
        catch (error) {
            logger?.warn('failed to remove tmp file');
        }
    });
    const obj = WAProto.Message.fromObject({
        [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
            url: mediaUrl,
            directPath,
            mediaKey,
            fileEncSha256,
            fileSha256,
            fileLength,
            mediaKeyTimestamp: unixTimestampSeconds(),
            ...uploadData,
            media: undefined
        })
    });
    if (uploadData.ptv) {
        obj.ptvMessage = obj.videoMessage;
        delete obj.videoMessage;
    }
    if (cacheableKey) {
        logger?.debug({ cacheableKey }, 'set cache');
        await options.mediaCache.set(cacheableKey, WAProto.Message.encode(obj).finish());
    }
    return obj;
};
export const prepareDisappearingMessageSettingContent = (ephemeralExpiration) => {
    ephemeralExpiration = ephemeralExpiration || 0;
    const content = {
        ephemeralMessage: {
            message: {
                protocolMessage: {
                    type: WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
                    ephemeralExpiration
                }
            }
        }
    };
    return WAProto.Message.fromObject(content);
};
/**
 * Generate forwarded message content like WA does
 * @param message the message to forward
 * @param options.forceForward will show the message as forwarded even if it is from you
 */
export const generateForwardMessageContent = (message, forceForward) => {
    let content = message.message;
    if (!content) {
        throw new Boom('no content in message', { statusCode: 400 });
    }
    // hacky copy
    content = normalizeMessageContent(content);
    content = proto.Message.decode(proto.Message.encode(content).finish());
    let key = Object.keys(content)[0];
    let score = content?.[key]?.contextInfo?.forwardingScore || 0;
    score += message.key.fromMe && !forceForward ? 0 : 1;
    if (key === 'conversation') {
        content.extendedTextMessage = { text: content[key] };
        delete content.conversation;
        key = 'extendedTextMessage';
    }
    const key_ = content?.[key];
    if (score > 0) {
        key_.contextInfo = { forwardingScore: score, isForwarded: true };
    }
    else {
        key_.contextInfo = {};
    }
    return content;
};
export const hasNonNullishProperty = (message, key) => {
    return (typeof message === 'object' &&
        message !== null &&
        key in message &&
        message[key] !== null &&
        message[key] !== undefined);
};
function hasOptionalProperty(obj, key) {
    return typeof obj === 'object' && obj !== null && key in obj && obj[key] !== null;
}
const richLayout = (name, data, extra = {}) => ({
    ...extra,
    view_model: {
        [Array.isArray(data) ? 'primitives' : 'primitive']: data,
        __typename: `GenAI${name}LayoutViewModel`
    }
});

const toUnifiedCodeBlocks = blocks => {
    const typeNames = { 0: 'DEFAULT', 1: 'KEYWORD', 2: 'METHOD', 3: 'STR', 4: 'NUMBER', 5: 'COMMENT' };
    return (Array.isArray(blocks) ? blocks : []).map(block => ({
        content: String(block?.codeContent ?? ''),
        type: typeNames[block?.highlightType] || 'DEFAULT'
    }));
};

const normalizeRichUrl = value => {
    if (typeof value === 'string') return value.trim();
    if (value && typeof value === 'object') {
        for (const key of ['url', 'imageHighResUrl', 'imagePreviewUrl', 'sourceUrl', 'thumbnailUrl', 'thumbnail_url']) {
            if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
        }
    }
    return '';
};

const extractRichInlineEntities = input => {
    const text = String(input ?? '').replace(/\[citation\]\((.+?)\)/g, (_match, url) => `[](${url})`);
    const inline_entities = [];
    let output = '';
    let lastIndex = 0;
    let hyperlinkIndex = 0;
    let citationIndex = 1;
    let latexIndex = 0;
    const pattern = /\[([^\]]*)\]\(([^)]+)\)|\[([^\]]*)\]<([^>]+)>/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        output += text.slice(lastIndex, match.index);
        const isLatex = match[3] !== undefined;
        const label = isLatex ? match[3].trim() : match[1].trim();
        const url = (isLatex ? match[4] : match[2]).trim();
        if (isLatex) {
            const [expression = '', width, height, fontHeight, padding] = label.split('|');
            const key = `RKA_LATEX_${latexIndex++}`;
            output += `{{${key}}}${expression || 'image'}{{/${key}}}`;
            inline_entities.push({
                key,
                metadata: {
                    latex_expression: expression || '',
                    latex_image: { url, width: Number(width) || 100, height: Number(height) || 100 },
                    font_height: Number(fontHeight) || 83.333333333333,
                    padding: Number(padding) || 15,
                    __typename: 'GenAILatexItem'
                }
            });
        } else if (!label) {
            const key = `RKA_CITATION_${citationIndex - 1}`;
            citationIndex++;
            output += `{{${key}}}${url}{{/${key}}}`;
            inline_entities.push({
                key,
                metadata: {
                    reference_id: String(citationIndex - 1),
                    reference_url: url,
                    reference_title: url,
                    reference_display_name: url,
                    sources: [],
                    __typename: 'GenAISearchCitationItem'
                }
            });
        } else {
            const trusted = !url.startsWith('!');
            const targetUrl = trusted ? url : url.slice(1);
            const key = `RKA_HYPERLINK_${hyperlinkIndex++}`;
            output += `{{${key}}}${targetUrl}{{/${key}}}`;
            inline_entities.push({
                key,
                metadata: {
                    display_name: label,
                    is_trusted: trusted,
                    url: targetUrl,
                    __typename: 'GenAIInlineLinkItem'
                }
            });
        }
        lastIndex = pattern.lastIndex;
    }
    output += text.slice(lastIndex);
    return { text: output, inline_entities };
};

const normalizeRichTable = table => {
    let title = '';
    let headers = [];
    let rows = [];
    if (Array.isArray(table)) {
        const normalized = table.map(row => Array.isArray(row) ? row.map(value => String(value ?? '')) : [String(row ?? '')]);
        headers = normalized.shift() || [];
        rows = normalized;
    } else if (table && typeof table === 'object') {
        title = typeof table.title === 'string' ? table.title : '';
        headers = Array.isArray(table.headers) ? table.headers.map(value => String(value ?? '')) : [];
        rows = Array.isArray(table.rows) ? table.rows.map(row => {
            if (Array.isArray(row)) return row.map(value => String(value ?? ''));
            if (row && typeof row === 'object') {
                const cells = Array.isArray(row.items) ? row.items : Array.isArray(row.cells) ? row.cells : [];
                return cells.map(cell => String(cell?.text ?? cell ?? ''));
            }
            return [String(row ?? '')];
        }) : [];
        if (!headers.length && rows.length && table.rows?.[0] && !Array.isArray(table.rows[0]) && (table.rows[0].isHeading || table.rows[0].is_header)) {
            headers = rows.shift();
        }
    }
    const hasHeaders = headers.length > 0;
    const width = Math.max(headers.length, 0, ...rows.map(row => row.length));
    const normalize = row => [...row, ...Array(Math.max(0, width - row.length)).fill('')];
    headers = normalize(headers);
    rows = rows.map(normalize);
    const protoRows = [];
    const unifiedRows = [];
    const toUnifiedRow = (cells, isHeader) => {
        const row = { is_header: isHeader, cells: [...cells] };
        const markdownCells = cells.map(cell => {
            const parsed = extractRichInlineEntities(cell);
            return { text: parsed.text, ...(parsed.inline_entities.length ? { inline_entities: parsed.inline_entities } : {}) };
        });
        if (markdownCells.some(cell => cell.inline_entities?.length)) row.markdown_cells = markdownCells;
        return row;
    };
    if (hasHeaders) {
        protoRows.push({ items: headers, isHeading: true });
        unifiedRows.push(toUnifiedRow(headers, true));
    }
    for (const row of rows) {
        protoRows.push({ items: row });
        unifiedRows.push(toUnifiedRow(row, false));
    }
    return { title, rows: protoRows, unifiedRows };
};

const normalizeRichSource = source => {
    if (Array.isArray(source)) {
        return {
            source_type: 'THIRD_PARTY',
            source_display_name: String(source[2] ?? ''),
            source_subtitle: 'AI',
            source_url: String(source[1] ?? ''),
            favicon: { url: String(source[0] ?? ''), mime_type: 'image/jpeg', width: 16, height: 16 }
        };
    }
    if (source && typeof source === 'object') return source;
    return { source_type: 'THIRD_PARTY', source_display_name: String(source ?? ''), source_subtitle: 'AI', source_url: '', favicon: { url: '', mime_type: 'image/jpeg', width: 16, height: 16 } };
};

const normalizeBotSource = (source, index = 0) => {
    const item = Array.isArray(source)
        ? { faviconCdnUrl: source[0], sourceProviderUrl: source[1], sourceTitle: source[2] }
        : (source && typeof source === 'object' ? source : { sourceTitle: source });
    return {
        provider: 4, // OTHER
        thumbnailCdnUrl: String(item.thumbnailCdnUrl ?? item.thumbnailCDNURL ?? item.thumbnail_url ?? item.faviconCdnUrl ?? item.favicon_url ?? ''),
        sourceProviderUrl: String(item.sourceProviderUrl ?? item.sourceProviderURL ?? item.source_url ?? ''),
        sourceQuery: String(item.sourceQuery ?? item.source_query ?? ''),
        faviconCdnUrl: String(item.faviconCdnUrl ?? item.faviconCDNURL ?? item.favicon_url ?? ''),
        citationNumber: Number.isFinite(Number(item.citationNumber)) ? Number(item.citationNumber) : index + 1,
        sourceTitle: String(item.sourceTitle ?? item.source_title ?? item.title ?? '')
    };
};

const buildRichMessageStructure = ({ submessages, sections, botJid = '0@bot', disclaimer = '', responseId, sources = [], messageSecret }) => ({
    messageContextInfo: {
        deviceListMetadata: {},
        deviceListMetadataVersion: 2,
        ...(messageSecret ? { messageSecret: Buffer.isBuffer(messageSecret) || messageSecret instanceof Uint8Array ? Buffer.from(messageSecret) : Buffer.from(String(messageSecret), 'base64') } : {}),
        botMetadata: {
            messageDisclaimerText: String(disclaimer ?? ''),
            richResponseSourcesMetadata: { sources: sources.map(normalizeBotSource) }
        }
    },
    botForwardedMessage: {
        message: {
            richResponseMessage: {
                messageType: 1,
                submessages,
                unifiedResponse: {
                    data: Buffer.from(JSON.stringify({ response_id: responseId || randomUUID(), sections }))
                },
                contextInfo: {
                    forwardingScore: 1,
                    isForwarded: true,
                    forwardedAiBotMessageInfo: { botJid: String(botJid || '0@bot') },
                    forwardOrigin: 4
                }
            }
        }
    }
});

const generateRichMessageV1 = rich => {
    const submessages = [];
    const sections = [];
    const richSources = [];

    if (rich.text !== undefined && rich.text !== null && String(rich.text).length) {
        const parsed = extractRichInlineEntities(rich.text);
        submessages.push({ messageType: 2, messageText: parsed.text });
        sections.push(richLayout('Single', {
            text: parsed.text,
            ...(parsed.inline_entities.length ? { inline_entities: parsed.inline_entities } : {}),
            __typename: 'GenAIMarkdownTextUXPrimitive'
        }));
    }

    if (rich.code !== undefined && rich.code !== null) {
        const codeValue = typeof rich.code === 'object' ? (rich.code.code ?? rich.code.content ?? '') : rich.code;
        const language = typeof rich.code === 'object' && rich.code.language ? String(rich.code.language) : 'javascript';
        const codeBlocks = tokenizeRichCode(String(codeValue), language);
        submessages.push({ messageType: 5, codeMetadata: { codeLanguage: language, codeBlocks } });
        sections.push(richLayout('Single', {
            language,
            code_blocks: toUnifiedCodeBlocks(codeBlocks),
            __typename: 'GenAICodeUXPrimitive'
        }));
    }

    if (rich.table) {
        const table = normalizeRichTable(rich.table);
        submessages.push({ messageType: 4, tableMetadata: { title: table.title, rows: table.rows } });
        sections.push(richLayout('Single', { title: table.title, rows: table.unifiedRows, __typename: 'GenAITableUXPrimitive' }));
    }

    const imageUrl = normalizeRichUrl(rich.image);
    if (imageUrl) {
        submessages.push({ messageType: 1, gridImageMetadata: {
            gridImageUrl: { imagePreviewUrl: imageUrl },
            imageUrls: [{ imagePreviewUrl: imageUrl, imageHighResUrl: imageUrl, sourceUrl: imageUrl }]
        }});
        sections.push(richLayout('Single', { media: { url: imageUrl, mime_type: 'image/jpeg' }, imagine_type: 3, status: { status: 'READY' }, __typename: 'GenAIImaginePrimitive' }));
    }

    if (rich.images) {
        const imageUrls = (Array.isArray(rich.images) ? rich.images : [rich.images]).map(normalizeRichUrl).filter(Boolean);
        if (imageUrls.length) {
            submessages.push({ messageType: 1, gridImageMetadata: {
                gridImageUrl: { imagePreviewUrl: imageUrls[0] },
                imageUrls: imageUrls.map(url => ({ imagePreviewUrl: url, imageHighResUrl: url, sourceUrl: url }))
            }});
            for (const url of imageUrls) sections.push(richLayout('Single', { media: { url, mime_type: 'image/jpeg' }, imagine_type: 3, status: { status: 'READY' }, __typename: 'GenAIImaginePrimitive' }));
        }
    }

    const videoUrl = normalizeRichUrl(rich.video);
    if (videoUrl) {
        const video = typeof rich.video === 'object' && rich.video ? rich.video : {};
        submessages.push({ messageType: 9, contentItemsMetadata: {
            contentType: 1,
            itemsMetadata: [{ reelItem: {
                title: String(video.title || ''),
                profileIconUrl: String(video.profileIconUrl || video.avatar || ''),
                thumbnailUrl: normalizeRichUrl(video.thumbnailUrl || video.thumbnail) || '',
                videoUrl
            } }]
        } });
        sections.push(richLayout('Single', { media: { url: videoUrl, mime_type: 'video/mp4', duration: Number(video.duration) || 10 }, imagine_type: 'ANIMATE', status: { status: 'READY' }, __typename: 'GenAIImaginePrimitive' }));
    }

    if (rich.productSingle && typeof rich.productSingle === 'object') {
        const product = rich.productSingle;
        sections.push({ view_model: { primitive: {
            title: product.title || '', brand: product.brand || '', price: product.price || '', sale_price: product.sale_price || '',
            product_url: product.product_url || '', image: { url: product.image || product.icon || '' },
            additional_images: product.additional_images || [{ url: product.icon || product.image || '' }], __typename: 'GenAIProductItemCardPrimitive'
        }, __typename: 'GenAISingleLayoutViewModel' } });
    }

    if (Array.isArray(rich.productMultiple) && rich.productMultiple.length) {
        sections.push({ view_model: { primitives: rich.productMultiple.filter(item => item && typeof item === 'object').map(product => ({
            title: product.title || '', brand: product.brand || '', price: product.price || '', sale_price: product.sale_price || '',
            product_url: product.product_url || '', image: { url: product.image || product.icon || '' },
            additional_images: product.additional_images || [{ url: product.icon || product.image || '' }], __typename: 'GenAIProductItemCardPrimitive'
        })), __typename: 'GenAIHScrollLayoutViewModel' } });
    }

    if (rich.post) {
        const posts = (Array.isArray(rich.post) ? rich.post : [rich.post]).filter(post => post && typeof post === 'object');
        if (posts.length) sections.push(richLayout('HScroll', posts.map(post => ({
            post_id: post.post_id || randomUUID(), source_app: post.source_app || 'INSTAGRAM', post_type: post.post_type || 'IMAGE',
            orientation: post.orientation || 'LANDSCAPE', title: post.title || '', subtitle: post.subtitle || '', username: post.username || '',
            is_verified: !!post.is_verified, profile_picture_url: post.profile_picture_url || '', thumbnail_url: post.thumbnail_url || '',
            post_caption: post.post_caption || '', post_url: post.post_url || '', post_deeplink: post.post_deeplink || post.post_url || '',
            likes_count: Number(post.likes_count) || 0, comments_count: Number(post.comments_count) || 0, shares_count: Number(post.shares_count) || 0,
            views_count: Number(post.views_count) || 0, footer_label: post.footer_label || '', footer_icon: post.footer_icon || '',
            is_carousel: posts.length > 1, __typename: 'GenAIPostPrimitive'
        }))));
    }

    if (rich.reels) {
        const reels = (Array.isArray(rich.reels) ? rich.reels : [rich.reels]).filter(item => item && typeof item === 'object').map(item => ({
            ...item,
            _avatar: item.profileIconUrl || item.profile_url || '',
            _thumbnail: item.thumbnailUrl || item.thumbnail || '',
            _videoUrl: item.videoUrl || item.url || ''
        }));
        if (reels.length) {
            submessages.push({ messageType: 9, contentItemsMetadata: {
                contentType: 1,
                itemsMetadata: reels.map(item => ({ reelItem: { title: item.title || '', profileIconUrl: item._avatar, thumbnailUrl: item._thumbnail, videoUrl: item._videoUrl } }))
            }});
            reels.forEach((item, index) => richSources.push({
                provider: 4, thumbnailCdnUrl: item._thumbnail, sourceProviderUrl: item._videoUrl,
                sourceQuery: '', faviconCdnUrl: item._avatar, citationNumber: index + 1, sourceTitle: item.title || ''
            }));
            sections.push(richLayout('HScroll', reels.map(item => ({
                reels_url: item._videoUrl, thumbnail_url: item._thumbnail, creator: item.title || '', avatar_url: item._avatar,
                reels_title: item.reels_title || item.title || '', likes_count: Number(item.likes_count) || 0, shares_count: Number(item.shares_count) || 0,
                view_count: Number(item.view_count) || 0, reel_source: item.reel_source || 'IG',
                is_verified: !!(item.is_verified || item.verified), __typename: 'GenAIReelPrimitive'
            }))));
        }
    }

    if (rich.sources) {
        const rawSources = Array.isArray(rich.sources) ? rich.sources : [rich.sources];
        const sourceItems = rawSources.map(normalizeRichSource);
        richSources.push(...rawSources);
        sections.push(richLayout('Single', { sources: sourceItems, __typename: 'GenAISearchResultPrimitive' }));
    }

    if (rich.tip) sections.push(richLayout('Single', { text: String(rich.tip), __typename: 'GenAIMetadataTextPrimitive' }));
    if (rich.suggestions) {
        const suggestions = (Array.isArray(rich.suggestions) ? rich.suggestions : [rich.suggestions]).map(value => String(value ?? '')).filter(Boolean);
        if (suggestions.length) sections.push(richLayout('ActionRow', suggestions.map(prompt_text => ({ prompt_text, prompt_type: 'SUGGESTED_PROMPT', __typename: 'GenAIFollowUpSuggestionPillPrimitive' }))));
    }
    if (rich.footer) sections.push(richLayout('Single', { text: String(rich.footer), __typename: 'GenAIMetadataTextPrimitive' }));
    if (!sections.length && !submessages.length) sections.push(richLayout('Single', { text: '', __typename: 'GenAIMarkdownTextUXPrimitive' }));

    return buildRichMessageStructure({ submessages, sections, botJid: rich.botJid || '0@bot', disclaimer: rich.title || rich.disclaimer || '', responseId: rich.responseId, sources: richSources, messageSecret: rich.messageSecret });
};

const generateRichMessageV2 = rich => {
    const submessages = [];
    const sections = [];
    if (rich.text !== undefined && rich.text !== null && String(rich.text).length) {
        const text = String(rich.text);
        submessages.push({ messageType: 2, messageText: text });
        sections.push(richLayout('Single', { text, __typename: 'GenAIMarkdownTextUXPrimitive' }));
    }
    if (rich.table) {
        const table = normalizeRichTable(rich.table);
        submessages.push({ messageType: 4, tableMetadata: { title: table.title, rows: table.rows } });
        sections.push(richLayout('Single', { title: table.title, rows: table.unifiedRows, __typename: 'GenAITableUXPrimitive' }));
    }
    if (rich.code !== undefined && rich.code !== null) {
        const codeValue = typeof rich.code === 'object' ? (rich.code.content ?? rich.code.code ?? '') : rich.code;
        const language = typeof rich.code === 'object' && rich.code.language ? String(rich.code.language) : 'javascript';
        const codeBlocks = tokenizeRichCode(String(codeValue), language);
        submessages.push({ messageType: 5, codeMetadata: { codeLanguage: language, codeBlocks } });
        sections.push(richLayout('Single', { language, code_blocks: toUnifiedCodeBlocks(codeBlocks), __typename: 'GenAICodeUXPrimitive' }));
    }
    if (!sections.length && !submessages.length) sections.push(richLayout('Single', { text: '', __typename: 'GenAIMarkdownTextUXPrimitive' }));
    return buildRichMessageStructure({ submessages, sections, botJid: rich.botJid || '0@bot', disclaimer: rich.disclaimer || '', responseId: rich.responseId, messageSecret: rich.messageSecret });
};

const readStickerPackInput = async (input, label) => {
    let value = input;
    if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Uint8Array) && typeof value.url === 'string') {
        value = value.url;
    }
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (value instanceof Uint8Array) return Buffer.from(value);
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (typeof value !== 'string' || !value.trim()) {
        throw new Boom(`${label} must be a URL, file path, Buffer or Uint8Array`, { statusCode: 400 });
    }
    if (value.startsWith('data:')) {
        const comma = value.indexOf(',');
        if (comma < 0) throw new Boom(`Invalid data URL for ${label}`, { statusCode: 400 });
        const header = value.slice(0, comma);
        const payload = value.slice(comma + 1);
        return header.includes(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload));
    }
    if (/^https?:\/\//i.test(value)) {
        const response = await fetch(value, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) {
            throw new Boom(`Failed to download ${label} (HTTP ${response.status})`, { statusCode: response.status || 502 });
        }
        return Buffer.from(await response.arrayBuffer());
    }
    return fs.readFile(value);
};

const generateStickerPackContent = async (pack, options) => {
    if (!pack || typeof pack !== 'object') {
        throw new Boom('stickerPack must be an object', { statusCode: 400 });
    }
    if (!Array.isArray(pack.stickers) || pack.stickers.length === 0) {
        throw new Boom('stickerPack.stickers must contain at least one sticker', { statusCode: 400 });
    }
    if (!options?.upload || typeof options.upload !== 'function') {
        throw new Boom('An upload function is required to send a sticker pack', { statusCode: 400 });
    }
    if (pack.cover === undefined || pack.cover === null) {
        throw new Boom('stickerPack.cover is required', { statusCode: 400 });
    }

    const stickerFiles = {};
    const stickerMetadata = [];
    for (let index = 0; index < pack.stickers.length; index++) {
        const item = pack.stickers[index];
        const stickerInput = item && typeof item === 'object' && !Buffer.isBuffer(item) && 'sticker' in item
            ? item.sticker
            : item;
        const buffer = await readStickerPackInput(stickerInput, `sticker ${index + 1}`);
        if (!buffer.length) throw new Boom(`Sticker ${index + 1} is empty`, { statusCode: 400 });
        const hash = sha256(buffer).toString('base64url');
        const fileName = `${String(index).padStart(2, '0')}_${hash}.webp`;
        stickerFiles[fileName] = [new Uint8Array(buffer), { level: 0 }];
        const metadata = item && typeof item === 'object' && !Buffer.isBuffer(item) ? item : {};
        stickerMetadata.push({
            fileName,
            mimetype: String(metadata.mimetype || metadata.mimeType || 'image/webp'),
            isAnimated: Boolean(metadata.isAnimated),
            isLottie: Boolean(metadata.isLottie),
            emojis: Array.isArray(metadata.emojis) ? metadata.emojis.map(String) : [],
            accessibilityLabel: String(metadata.accessibilityLabel || '')
        });
    }

    const zipBuffer = await new Promise((resolve, reject) => {
        zip(stickerFiles, { level: 0 }, (error, data) => {
            if (error) reject(error);
            else resolve(Buffer.from(data));
        });
    });
    if (!zipBuffer.length) throw new Boom('Failed to create the sticker pack archive', { statusCode: 500 });

    const coverBuffer = await readStickerPackInput(pack.cover, 'sticker pack cover');
    if (!coverBuffer.length) throw new Boom('Sticker pack cover is empty', { statusCode: 400 });

    let encryptedPack;
    try {
        encryptedPack = await encryptedStream(zipBuffer, 'sticker-pack', { logger: options.logger, opts: options.options });
        const coverMedia = await prepareWAMessageMedia({ image: coverBuffer }, { ...options, mediaTypeOverride: 'image' });
        const uploadResult = await options.upload(encryptedPack.encFilePath, {
            fileEncSha256B64: encryptedPack.fileEncSha256.toString('base64'),
            mediaType: 'sticker-pack',
            timeoutMs: options.mediaUploadTimeoutMs
        });
        if (!uploadResult?.directPath) {
            throw new Boom('Sticker pack upload did not return a directPath', { statusCode: 502 });
        }

        const cover = coverMedia.imageMessage || {};
        const stickerPackId = String(pack.packId || generateMessageIDV2());
        return {
            stickerPackMessage: proto.Message.StickerPackMessage.fromObject({
                name: String(pack.name || ''),
                publisher: String(pack.publisher || ''),
                stickerPackId,
                packDescription: String(pack.description || ''),
                stickerPackOrigin: proto.Message.StickerPackMessage.StickerPackOrigin.THIRD_PARTY,
                stickerPackSize: encryptedPack.fileLength,
                stickers: stickerMetadata,
                fileSha256: encryptedPack.fileSha256,
                fileEncSha256: encryptedPack.fileEncSha256,
                mediaKey: encryptedPack.mediaKey,
                directPath: uploadResult.directPath,
                fileLength: encryptedPack.fileLength,
                mediaKeyTimestamp: unixTimestampSeconds(),
                trayIconFileName: `${stickerPackId}.png`,
                imageDataHash: sha256(coverBuffer).toString('base64'),
                thumbnailDirectPath: cover.directPath,
                thumbnailSha256: cover.fileSha256,
                thumbnailEncSha256: cover.fileEncSha256,
                thumbnailHeight: cover.height || 0,
                thumbnailWidth: cover.width || 0,
                ...(pack.contextInfo ? { contextInfo: pack.contextInfo } : {})
            })
        };
    }
    finally {
        if (encryptedPack?.encFilePath) {
            await fs.unlink(encryptedPack.encFilePath).catch(() => undefined);
        }
        if (encryptedPack?.originalFilePath) {
            await fs.unlink(encryptedPack.originalFilePath).catch(() => undefined);
        }
    }
};

const applyContextInfoAndMentions = (interactiveMessage, message) => {
	if ('contextInfo' in message && !!message.contextInfo) {
		interactiveMessage.contextInfo = message.contextInfo
	}
	if ('mentions' in message && !!message.mentions) {
		interactiveMessage.contextInfo = {
			...(interactiveMessage.contextInfo || {}),
			mentionedJid: message.mentions
		}
	}
}
export const generateWAMessageContent = async (message, options) => {
    var _a, _b;
    let m = {};
    if ('interactiveButtons' in message && !!message.interactiveButtons) {
        const nativeFlow = proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
            buttons: message.interactiveButtons,
            messageParamsJson: message.messageParams ?? "{}"
        });
        let interactiveMessage = { nativeFlowMessage: nativeFlow };
        if ('text' in message) {
            interactiveMessage.body = { text: message.text };
        } else if ('caption' in message) {
            interactiveMessage.body = { text: message.caption };
        }
        if ('title' in message && !!message.title) {
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle || "",
                hasMediaAttachment: false
            };
            let media = null;
            if ('image' in message && !!message.image) {
                media = await prepareWAMessageMedia({ image: message.image }, options);
                interactiveMessage.header.imageMessage = media.imageMessage;
                if (message.image.caption) {
                    interactiveMessage.header.imageMessage.caption = message.image.caption;
                }
            } else if ('video' in message && !!message.video) {
                media = await prepareWAMessageMedia({ video: message.video }, options);
                interactiveMessage.header.videoMessage = media.videoMessage;
                if (message.video.caption) {
                    interactiveMessage.header.videoMessage.caption = message.video.caption;
                }
            } else if ('gif' in message && !!message.gif) {
                media = await prepareWAMessageMedia({ video: message.gif }, options);
                interactiveMessage.header.videoMessage = media.videoMessage;
                interactiveMessage.header.videoMessage.gifPlayback = true;
                if (message.gif.caption) {
                    interactiveMessage.header.videoMessage.caption = message.gif.caption;
                }
            } else if ('document' in message && !!message.document) {
                media = await prepareWAMessageMedia({ document: message.document }, options);
                interactiveMessage.header.documentMessage = media.documentMessage;
                let docuR = interactiveMessage.header.documentMessage;
                docuR.fileName = message.document.fileName || "Document";
                docuR.mimetype = message.document.mimetype || docuR.mimetype;
                if (message.document.caption) docuR.caption = message.document.caption;
                if (message.document.jpegThumbnail) docuR.jpegThumbnail = message.document.jpegThumbnail;
            } else if ('location' in message && !!message.location) {
                let mLoc = message.location;
                interactiveMessage.header.locationMessage = {
                    degreesLongitude: mLoc.longitude || 0,
                    degreesLatitude: mLoc.latitude || 0,
                    name: mLoc.name || null,
                    address: mLoc.address || null,
                    url: mLoc.url || null
                };
                media = true;
            } else if ('thumbnail' in message && !!message.thumbnail) {
                interactiveMessage.header.jpegThumbnail = message.thumbnail;
            }
            if (media || ('thumbnail' in message && !!message.thumbnail)) {
                interactiveMessage.header.hasMediaAttachment = true;
            }
        }
        if ('footer' in message && !!message.footer) {
            interactiveMessage.footer = { text: message.footer };
        }
        applyContextInfoAndMentions(interactiveMessage, message);
        m = { interactiveMessage };
    }
	else if ('buttons' in message && !!message.buttons) {
        const buttonsMessage = {
            buttons: message.buttons.map(b => ({ ...b, type: proto.Message.ButtonsMessage.Button.Type.RESPONSE }))
        };
        if ('text' in message) {
            buttonsMessage.contentText = message.text;
            buttonsMessage.headerType = ButtonType.EMPTY;
        }
        else {
            if ('caption' in message) {
                buttonsMessage.contentText = message.caption;
            }
            const contentType = getContentType(m);
            const type = contentType.replace('Message', '').toUpperCase();
            buttonsMessage.headerType = ButtonType[type];
            Object.assign(buttonsMessage, m);
        }
        if ('footer' in message && !!message.footer) {
            buttonsMessage.footerText = message.footer;
        }
        m = { buttonsMessage };
    }
    else if ('templateButtons' in message && Array.isArray(message.templateButtons)) {
        let baseContent = {};
        if (message.image) baseContent = await prepareWAMessageMedia({ image: message.image }, options);
        else if (message.video) baseContent = await prepareWAMessageMedia({ video: message.video }, options);
        else if (message.document) baseContent = await prepareWAMessageMedia({ document: message.document }, options);
        const template = {
            hydratedButtons: message.templateButtons,
            ...(message.text !== undefined ? { hydratedContentText: String(message.text) } : message.caption !== undefined ? { hydratedContentText: String(message.caption) } : {}),
            ...(message.title ? { hydratedTitleText: String(message.title) } : {}),
            ...(message.footer ? { hydratedFooterText: String(message.footer) } : {}),
            ...baseContent
        };
        m = { templateMessage: { fourRowTemplate: template, hydratedTemplate: template } };
    }
    else if ('sections' in message && Array.isArray(message.sections)) {
        m = { listMessage: {
            sections: message.sections,
            buttonText: message.buttonText,
            title: message.title,
            footerText: message.footer,
            description: message.text ?? message.caption,
            listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
            contextInfo: message.contextInfo
        } };
    }
    else if ('shop' in message && !!message.shop) {
        const shopMessage = proto.Message.InteractiveMessage.ShopMessage.fromObject({
            surface: message.shop,
            id: message.id,
            messageVersion: message.messageVersion || 1
        });
        const interactiveMessage = { shopStorefrontMessage: shopMessage };
        const body = message.text ?? message.caption;
        if (body !== undefined && body !== null) interactiveMessage.body = { text: String(body) };
        if (message.title || message.subtitle) {
            interactiveMessage.header = {
                title: message.title || '',
                subtitle: message.subtitle || '',
                hasMediaAttachment: false
            };
            if (message.image) {
                const media = await prepareWAMessageMedia({ image: message.image }, options);
                Object.assign(interactiveMessage.header, media);
                interactiveMessage.header.hasMediaAttachment = true;
            } else if (message.video) {
                const media = await prepareWAMessageMedia({ video: message.video }, options);
                Object.assign(interactiveMessage.header, media);
                interactiveMessage.header.hasMediaAttachment = true;
            } else if (message.document) {
                const media = await prepareWAMessageMedia({ document: message.document }, options);
                Object.assign(interactiveMessage.header, media);
                interactiveMessage.header.hasMediaAttachment = true;
            } else if (message.thumbnail) {
                interactiveMessage.header.jpegThumbnail = message.thumbnail;
                interactiveMessage.header.hasMediaAttachment = true;
            }
        }
        if (message.footer) interactiveMessage.footer = { text: String(message.footer) };
        applyContextInfoAndMentions(interactiveMessage, message);
        m = { interactiveMessage };
    }
    else if ('richMessage' in message && message.richMessage && typeof message.richMessage === 'object') {
        m = generateRichMessageV1(message.richMessage);
    }
    else if ('richMessageV2' in message && message.richMessageV2 && typeof message.richMessageV2 === 'object') {
        m = generateRichMessageV2(message.richMessageV2);
    }
    else if ('richResponse' in message && message.richResponse && typeof message.richResponse === 'object') {
		const {
			text,
			code,
			language = 'javascript',
			botJid = '867051314767696@bot',
			table,
			latex,
			map,
			imageUrl,
			imageUrls,
			responseId,
			messageSecret: richSecret
		} = message.richResponse
		const sections = []
		const submessages = []
		if (text) {
			submessages.push({ messageType: 2, messageText: String(text) })
			sections.push({
				view_model: {
					primitive: { text, __typename: 'GenAIMarkdownTextUXPrimitive' },
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		if (code) {
			const codeBlocks = tokenizeRichCode(String(code), language)
			submessages.push({ messageType: 5, codeMetadata: { codeLanguage: language, codeBlocks } })
			sections.push({
				view_model: {
					primitive: {
						language,
						code_blocks: toUnifiedCodeBlocks(codeBlocks),
						__typename: 'GenAICodeUXPrimitive'
					},
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		if (table && Array.isArray(table.rows)) {
			const normalizedTable = normalizeRichTable(table)
			submessages.push({ messageType: 4, tableMetadata: { title: normalizedTable.title, rows: normalizedTable.rows } })
			sections.push({
				view_model: {
					primitive: {
						title: normalizedTable.title,
						rows: normalizedTable.unifiedRows,
						__typename: 'GenAITableUXPrimitive'
					},
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		if (latex) {
			const expressions = (Array.isArray(latex) ? latex : [latex]).map(entry => {
				if (typeof entry === 'string') return { latexExpression: entry }
				return {
					latexExpression: entry?.latexExpression ?? entry?.expression ?? entry?.text ?? '',
					url: entry?.url,
					width: entry?.width,
					height: entry?.height,
					fontHeight: entry?.fontHeight ?? entry?.font_height,
					imageTopPadding: entry?.imageTopPadding,
					imageLeadingPadding: entry?.imageLeadingPadding,
					imageBottomPadding: entry?.imageBottomPadding,
					imageTrailingPadding: entry?.imageTrailingPadding
				}
			})
			submessages.push({ messageType: 8, latexMetadata: { text: typeof text === 'string' ? text : '', expressions } })
			const sectionExpressions = (Array.isArray(latex) ? latex : [latex]).map(e => typeof e === 'string' ? { expression: e } : e)
			sections.push({
				view_model: {
					primitive: { expressions: sectionExpressions, __typename: 'GenAILatexUXPrimitive' },
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		if (map) {
			submessages.push({ messageType: 7, mapMetadata: {
				centerLatitude: map.centerLatitude ?? map.latitude,
				centerLongitude: map.centerLongitude ?? map.longitude,
				latitudeDelta: map.latitudeDelta,
				longitudeDelta: map.longitudeDelta,
				annotations: Array.isArray(map.annotations) ? map.annotations : [],
				showInfoList: map.showInfoList
			} })
			sections.push({
				view_model: {
					primitive: {
						latitude: map.latitude,
						longitude: map.longitude,
						zoom: map.zoom,
						title: map.title,
						annotations: map.annotations || [],
						__typename: 'GenAIMapUXPrimitive'
					},
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		const normalizedInlineImageUrl = normalizeRichUrl(imageUrl)
		if (normalizedInlineImageUrl) {
			submessages.push({ messageType: 3, imageMetadata: { imageUrl: { imagePreviewUrl: normalizedInlineImageUrl, imageHighResUrl: normalizedInlineImageUrl }, alignment: 2 } })
			sections.push({
				view_model: {
					primitive: { url: normalizedInlineImageUrl, __typename: 'GenAIInlineImageUXPrimitive' },
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		if (imageUrls && Array.isArray(imageUrls) && imageUrls.length > 0) {
			const urls = imageUrls.map(normalizeRichUrl).filter(Boolean)
			if (urls.length) {
				submessages.push({ messageType: 1, gridImageMetadata: { gridImageUrl: { imagePreviewUrl: urls[0] }, imageUrls: urls.map(url => ({ imagePreviewUrl: url, imageHighResUrl: url, sourceUrl: url })) } })
				sections.push({
					view_model: {
						primitive: {
							urls: urls.map(url => ({ url })),
						__typename: 'GenAIGridImageUXPrimitive'
					},
					__typename: 'GenAISingleLayoutViewModel'
				}
				})
			}
		}
		if (!sections.length && !text) {
			sections.push({
				view_model: {
					primitive: { text: '', __typename: 'GenAIMarkdownTextUXPrimitive' },
					__typename: 'GenAISingleLayoutViewModel'
				}
			})
		}
		const unifiedData = {
			response_id: responseId || randomUUID(),
			sections
		}
		return proto.Message.fromObject({
			messageContextInfo: {
				deviceListMetadata: {},
				deviceListMetadataVersion: 2,
				messageSecret: richSecret || randomBytes(32)
			},
			botForwardedMessage: {
				message: {
					richResponseMessage: {
						submessages,
						messageType: 1,
						unifiedResponse: { data: Buffer.from(JSON.stringify(unifiedData)) },
						contextInfo: {
							forwardingScore: 2,
							isForwarded: true,
							forwardedAiBotMessageInfo: { botJid },
							botMessageSharingInfo: {
								botEntryPointOrigin: 1,
								forwardScore: 2
							}
						}
					}
				}
			}
		})
	}
    else if (hasNonNullishProperty(message, 'buttonsMessage')) {
        const source = message.buttonsMessage || {};
        let locationMessage = source.locationMessage;
        if (locationMessage) {
            const location = locationMessage;
            let jpegThumbnail = location.jpegThumbnail || location.thumbnail;
            if (jpegThumbnail !== undefined && jpegThumbnail !== null && !(Buffer.isBuffer(jpegThumbnail) || jpegThumbnail instanceof Uint8Array)) {
                jpegThumbnail = await readStickerPackInput(jpegThumbnail, 'buttonsMessage location thumbnail');
            }
            locationMessage = proto.Message.LocationMessage.fromObject({
                ...location,
                degreesLatitude: location.degreesLatitude ?? 0,
                degreesLongitude: location.degreesLongitude ?? 0,
                name: location.name || '',
                address: location.address || '',
                jpegThumbnail
            });
        }
        const buttons = (Array.isArray(source.buttons) ? source.buttons : []).map(button => proto.Message.ButtonsMessage.Button.fromObject({
            ...button,
            buttonId: button.buttonId || '',
            buttonText: { displayText: button.buttonText?.displayText || '' },
            type: button.type ?? proto.Message.ButtonsMessage.Button.Type.RESPONSE,
            ...(button.nativeFlowInfo ? { nativeFlowInfo: {
                name: button.nativeFlowInfo.name || '',
                paramsJson: button.nativeFlowInfo.paramsJson || button.nativeFlowInfo.buttonParamsJson || ''
            } } : {})
        }));
        const detectedHeaderType = locationMessage ? ButtonType.LOCATION
            : source.imageMessage ? ButtonType.IMAGE
                : source.videoMessage ? ButtonType.VIDEO
                    : source.documentMessage ? ButtonType.DOCUMENT
                        : source.text ? ButtonType.TEXT : ButtonType.EMPTY;
        m.buttonsMessage = proto.Message.ButtonsMessage.fromObject({
            ...source,
            locationMessage,
            contentText: String(source.contentText || ''),
            footerText: String(source.footerText || ''),
            buttons,
            headerType: source.headerType ?? detectedHeaderType,
            viewOnce: Boolean(source.viewOnce)
        });
    }
    else if ('botInvoke' in message && !!message.botInvoke) {
	    m = {
	        botInvokeMessage: {
	            message: message.botInvoke
	        }
	    }
	}
    else if (hasNonNullishProperty(message, 'text')) {
        const extContent = { text: message.text };
        let urlInfo = message.linkPreview;
        if (typeof urlInfo === 'undefined') {
            urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger);
        }
        if (urlInfo) {
            extContent.matchedText = urlInfo['matched-text'];
            extContent.jpegThumbnail = urlInfo.jpegThumbnail;
            extContent.description = urlInfo.description;
            extContent.title = urlInfo.title;
            extContent.previewType = 0;
            const img = urlInfo.highQualityThumbnail;
            if (img) {
                extContent.thumbnailDirectPath = img.directPath;
                extContent.mediaKey = img.mediaKey;
                extContent.mediaKeyTimestamp = img.mediaKeyTimestamp;
                extContent.thumbnailWidth = img.width;
                extContent.thumbnailHeight = img.height;
                extContent.thumbnailSha256 = img.fileSha256;
                extContent.thumbnailEncSha256 = img.fileEncSha256;
            }
        }
        if (options.backgroundColor) {
            extContent.backgroundArgb = await assertColor(options.backgroundColor);
        }
        if (options.font) {
            extContent.font = options.font;
        }
        m.extendedTextMessage = extContent;
    }
    else if (hasNonNullishProperty(message, 'contacts')) {
        const contactLen = message.contacts.contacts.length;
        if (!contactLen) {
            throw new Boom('require atleast 1 contact', { statusCode: 400 });
        }
        if (contactLen === 1) {
            m.contactMessage = WAProto.Message.ContactMessage.create(message.contacts.contacts[0]);
        }
        else {
            m.contactsArrayMessage = WAProto.Message.ContactsArrayMessage.create(message.contacts);
        }
    }
    else if (hasNonNullishProperty(message, 'location')) {
        m.locationMessage = WAProto.Message.LocationMessage.create(message.location);
    }
    else if (hasNonNullishProperty(message, 'react')) {
        if (!message.react.senderTimestampMs) {
            message.react.senderTimestampMs = Date.now();
        }
        m.reactionMessage = WAProto.Message.ReactionMessage.create(message.react);
    }
    else if (hasNonNullishProperty(message, 'delete')) {
        m.protocolMessage = {
            key: message.delete,
            type: WAProto.Message.ProtocolMessage.Type.REVOKE
        };
    }
    else if (hasNonNullishProperty(message, 'forward')) {
        m = generateForwardMessageContent(message.forward, message.force);
    }
    else if (hasNonNullishProperty(message, 'disappearingMessagesInChat')) {
        const exp = typeof message.disappearingMessagesInChat === 'boolean'
            ? message.disappearingMessagesInChat
                ? WA_DEFAULT_EPHEMERAL
                : 0
            : message.disappearingMessagesInChat;
        m = prepareDisappearingMessageSettingContent(exp);
    }
    else if (hasNonNullishProperty(message, 'groupInvite')) {
        m.groupInviteMessage = {};
        m.groupInviteMessage.inviteCode = message.groupInvite.inviteCode;
        m.groupInviteMessage.inviteExpiration = message.groupInvite.inviteExpiration;
        m.groupInviteMessage.caption = message.groupInvite.text;
        m.groupInviteMessage.groupJid = message.groupInvite.jid;
        m.groupInviteMessage.groupName = message.groupInvite.subject;
        //TODO: use built-in interface and get disappearing mode info etc.
        //TODO: cache / use store!?
        if (options.getProfilePicUrl) {
            const pfpUrl = await options.getProfilePicUrl(message.groupInvite.jid, 'preview');
            if (pfpUrl) {
                const resp = await fetch(pfpUrl, { method: 'GET', dispatcher: options?.options?.dispatcher });
                if (resp.ok) {
                    const buf = Buffer.from(await resp.arrayBuffer());
                    m.groupInviteMessage.jpegThumbnail = buf;
                }
            }
        }
    }
    else if (hasNonNullishProperty(message, 'pin')) {
        m.pinInChatMessage = {};
        m.messageContextInfo = {};
        m.pinInChatMessage.key = message.pin;
        m.pinInChatMessage.type = message.type;
        m.pinInChatMessage.senderTimestampMs = Date.now();
        m.messageContextInfo.messageAddOnDurationInSecs = message.type === 1 ? message.time || 86400 : 0;
    }
    else if (hasNonNullishProperty(message, 'keep')) {
        m.keepInChatMessage = proto.Message.KeepInChatMessage.fromObject({
            key: message.keep,
            keepType: message.type,
            timestampMs: message.timestampMs ?? Date.now()
        });
    }
    else if (hasNonNullishProperty(message, 'call')) {
        const rawCallType = message.call.type;
        const callType = typeof rawCallType === 'string'
            ? (/^\d+$/.test(rawCallType)
                ? Number(rawCallType)
                : ['audio', 'voice'].includes(rawCallType.toLowerCase())
                    ? proto.Message.ScheduledCallCreationMessage.CallType.VOICE
                    : rawCallType.toLowerCase() === 'video'
                        ? proto.Message.ScheduledCallCreationMessage.CallType.VIDEO
                        : rawCallType.toUpperCase())
            : (rawCallType ?? proto.Message.ScheduledCallCreationMessage.CallType.VOICE);
        m.scheduledCallCreationMessage = proto.Message.ScheduledCallCreationMessage.fromObject({
            scheduledTimestampMs: message.call.time ?? Date.now(),
            callType,
            title: message.call.title
        });
    }
    else if (hasNonNullishProperty(message, 'paymentInvite')) {
        const invite = message.paymentInvite;
        const serviceType = invite.serviceType ?? invite.type ?? proto.Message.PaymentInviteMessage.ServiceType.UNKNOWN;
        const inviteType = invite.inviteType;
        m.paymentInviteMessage = proto.Message.PaymentInviteMessage.fromObject({
            serviceType: typeof serviceType === 'string' ? serviceType.toUpperCase() : serviceType,
            expiryTimestamp: invite.expiryTimestamp ?? invite.expiry,
            incentiveEligible: invite.incentiveEligible,
            referralId: invite.referralId,
            inviteType: typeof inviteType === 'string' ? inviteType.toUpperCase() : inviteType
        });
    }
    else if (hasNonNullishProperty(message, 'inviteAdmin')) {
        const invite = message.inviteAdmin;
        let jpegThumbnail = invite.thumbnail;
        if (typeof jpegThumbnail === 'string' && jpegThumbnail) {
            jpegThumbnail = await readStickerPackInput(jpegThumbnail, 'newsletter invite thumbnail');
        }
        m.newsletterAdminInviteMessage = proto.Message.NewsletterAdminInviteMessage.fromObject({
            inviteExpiration: invite.inviteExpiration,
            caption: invite.text,
            newsletterJid: invite.jid,
            newsletterName: invite.subject,
            jpegThumbnail,
            contextInfo: invite.contextInfo
        });
    }
    else if (hasNonNullishProperty(message, 'groupStatus')) {
        const status = message.groupStatus;
        if (status.message === undefined || status.message === null) {
            throw new Boom('groupStatus.message is required', { statusCode: 400 });
        }
        const audienceType = status.audienceType ?? 0;
        const backgroundColor = status.backgroundArgb !== undefined ? await assertColor(status.backgroundArgb) : undefined;
        const textColor = status.textArgb !== undefined ? await assertColor(status.textArgb) : undefined;
        let statusContent = status.message;
        if (typeof statusContent === 'string') {
            statusContent = {
                extendedTextMessage: {
                    text: statusContent,
                    contextInfo: { statusAudienceMetadata: { audienceType } },
                    ...(backgroundColor !== undefined ? { backgroundArgb: backgroundColor } : {}),
                    ...(textColor !== undefined ? { textArgb: textColor } : {}),
                    ...(status.font !== undefined ? { font: status.font } : {})
                }
            };
        }
        else if (statusContent?.extendedTextMessage) {
            statusContent = {
                ...statusContent,
                extendedTextMessage: {
                    ...statusContent.extendedTextMessage,
                    ...(backgroundColor !== undefined ? { backgroundArgb: backgroundColor } : {}),
                    ...(textColor !== undefined ? { textArgb: textColor } : {}),
                    ...(status.font !== undefined ? { font: status.font } : {}),
                    contextInfo: {
                        ...(statusContent.extendedTextMessage.contextInfo || {}),
                        statusAudienceMetadata: { audienceType }
                    }
                }
            };
        }
        else if (statusContent && typeof statusContent === 'object') {
            const mediaKey = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].find(key => statusContent[key]);
            if (mediaKey) {
                statusContent = {
                    ...statusContent,
                    [mediaKey]: {
                        ...statusContent[mediaKey],
                        contextInfo: {
                            ...(statusContent[mediaKey].contextInfo || {}),
                            statusAudienceMetadata: { audienceType }
                        }
                    }
                };
            }
        }
        m.groupStatusMessageV2 = { message: statusContent };
    }
    else if (hasNonNullishProperty(message, 'orderStatus')) {
        const orderStatus = message.orderStatus;
        if (!orderStatus.image) throw new Boom('orderStatus.image is required', { statusCode: 400 });
        const imageInput = typeof orderStatus.image === 'string'
            ? await readStickerPackInput(orderStatus.image, 'order status image')
            : orderStatus.image;
        const media = await prepareWAMessageMedia({ image: imageInput }, options);
        const referenceId = String(orderStatus.referenceId || `RKA-${Date.now()}`);
        m.viewOnceMessage = {
            message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                    header: {
                        title: String(orderStatus.title || 'Order Status'),
                        hasMediaAttachment: true,
                        ...media
                    },
                    body: { text: String(orderStatus.text || 'Silakan cek status pesanan Anda.') },
                    footer: { text: String(orderStatus.footer || 'Powered by R,K,A DESIGN') },
                    nativeFlowMessage: {
                        buttons: [{
                            name: 'order_status',
                            buttonParamsJson: JSON.stringify({
                                reference_id: referenceId,
                                order: {
                                    status: String(orderStatus.status || 'PROCESSING'),
                                    subtotal: { value: Number(orderStatus.subtotalValue) || 0, offset: Number(orderStatus.subtotalOffset) || 100 },
                                    tax: { value: Number(orderStatus.taxValue) || 0, offset: Number(orderStatus.taxOffset) || 100 },
                                    currency: String(orderStatus.currency || 'IDR')
                                }
                            })
                        }]
                    }
                })
            }
        };
    }
    else if (hasNonNullishProperty(message, 'buttonReply')) {
        switch (message.type) {
            case 'template':
                m.templateButtonReplyMessage = {
                    selectedDisplayText: message.buttonReply.displayText,
                    selectedId: message.buttonReply.id,
                    selectedIndex: message.buttonReply.index
                };
                break;
            case 'plain':
                m.buttonsResponseMessage = {
                    selectedButtonId: message.buttonReply.id,
                    selectedDisplayText: message.buttonReply.displayText,
                    type: proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT
                };
                break;
        }
    }
    else if (hasOptionalProperty(message, 'ptv') && message.ptv) {
        const { videoMessage } = await prepareWAMessageMedia({ video: message.ptv }, options);
        m.ptvMessage = videoMessage;
    }
    else if (hasNonNullishProperty(message, 'product')) {
        const { imageMessage } = await prepareWAMessageMedia({ image: message.product.productImage }, options);
        m.productMessage = WAProto.Message.ProductMessage.create({
            ...message,
            product: {
                ...message.product,
                productImage: imageMessage
            }
        });
    }
    else if (hasNonNullishProperty(message, 'order')) {
        const order = message.order;
        m.orderMessage = proto.Message.OrderMessage.fromObject({
            orderId: order.id,
            thumbnail: order.thumbnail,
            itemCount: order.itemCount,
            status: order.status,
            surface: order.surface,
            orderTitle: order.title,
            message: order.text,
            sellerJid: order.seller,
            token: order.token,
            totalAmount1000: order.amount,
            totalCurrencyCode: order.currency,
            contextInfo: order.contextInfo
        });
    }
    else if (hasNonNullishProperty(message, 'stickerPack')) {
        m = await generateStickerPackContent(message.stickerPack, options);
    }
    else if (hasNonNullishProperty(message, 'listReply')) {
        m.listResponseMessage = { ...message.listReply };
    }
    else if (hasNonNullishProperty(message, 'event')) {
        m.eventMessage = {};
        const startTime = Math.floor(message.event.startDate.getTime() / 1000);
        if (message.event.call && options.getCallLink) {
            const token = await options.getCallLink(message.event.call, { startTime });
            m.eventMessage.joinLink = (message.event.call === 'audio' ? CALL_AUDIO_PREFIX : CALL_VIDEO_PREFIX) + token;
        }
        m.messageContextInfo = {
            // encKey
            messageSecret: message.event.messageSecret || randomBytes(32)
        };
        m.eventMessage.name = message.event.name;
        m.eventMessage.description = message.event.description;
        m.eventMessage.startTime = startTime;
        m.eventMessage.endTime = message.event.endDate ? message.event.endDate.getTime() / 1000 : undefined;
        m.eventMessage.isCanceled = message.event.isCancelled ?? false;
        m.eventMessage.extraGuestsAllowed = message.event.extraGuestsAllowed;
        m.eventMessage.isScheduleCall = message.event.isScheduleCall ?? false;
        m.eventMessage.location = message.event.location;
    }
    else if (hasNonNullishProperty(message, 'poll')) {
        (_a = message.poll).selectableCount || (_a.selectableCount = 0);
        (_b = message.poll).toAnnouncementGroup || (_b.toAnnouncementGroup = false);
        if (!Array.isArray(message.poll.values)) {
            throw new Boom('Invalid poll values', { statusCode: 400 });
        }
        if (message.poll.selectableCount < 0 || message.poll.selectableCount > message.poll.values.length) {
            throw new Boom(`poll.selectableCount in poll should be >= 0 and <= ${message.poll.values.length}`, {
                statusCode: 400
            });
        }
        m.messageContextInfo = {
            // encKey
            messageSecret: message.poll.messageSecret || randomBytes(32)
        };
        const pollCreationMessage = {
            name: message.poll.name,
            selectableOptionsCount: message.poll.selectableCount,
            options: message.poll.values.map(optionName => ({ optionName }))
        };
        if (message.poll.toAnnouncementGroup) {
            // poll v2 is for community announcement groups (single select and multiple)
            m.pollCreationMessageV2 = pollCreationMessage;
        }
        else {
            if (message.poll.selectableCount === 1) {
                //poll v3 is for single select polls
                m.pollCreationMessageV3 = pollCreationMessage;
            }
            else {
                // poll for multiple choice polls
                m.pollCreationMessage = pollCreationMessage;
            }
        }
    }
    else if (hasNonNullishProperty(message, 'album')) {
        m.albumMessage = {
            expectedImageCount: message.album.expectedImageCount,
            expectedVideoCount: message.album.expectedVideoCount
        };
    }
    else if (hasNonNullishProperty(message, 'requestPayment')) {
        const payment = message.requestPayment;
        let noteMessage;
        if (payment.sticker !== undefined && payment.sticker !== null) {
            const stickerContent = await prepareWAMessageMedia({ sticker: payment.sticker }, options);
            noteMessage = {
                stickerMessage: {
                    ...stickerContent.stickerMessage,
                    ...(payment.contextInfo ? { contextInfo: payment.contextInfo } : {})
                }
            };
        }
        else if (typeof payment.note === 'string' && payment.note.length) {
            noteMessage = {
                extendedTextMessage: {
                    text: payment.note,
                    ...(payment.contextInfo ? { contextInfo: payment.contextInfo } : {})
                }
            };
        }
        else {
            throw new Boom('requestPayment requires either a note or sticker', { statusCode: 400 });
        }
        m.requestPaymentMessage = proto.Message.RequestPaymentMessage.fromObject({
            expiryTimestamp: payment.expiryTimestamp ?? payment.expiry,
            amount1000: payment.amount1000 ?? payment.amount,
            currencyCodeIso4217: payment.currencyCodeIso4217 ?? payment.currency,
            requestFrom: payment.requestFrom ?? payment.from,
            noteMessage,
            background: payment.background ?? undefined
        });
    }
    else if (hasNonNullishProperty(message, 'sharePhoneNumber')) {
        m.protocolMessage = {
            type: proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER
        };
    }
    else if (hasNonNullishProperty(message, 'requestPhoneNumber')) {
        m.requestPhoneNumberMessage = {};
    }
    else if (hasNonNullishProperty(message, 'limitSharing')) {
        m.protocolMessage = {
            type: proto.Message.ProtocolMessage.Type.LIMIT_SHARING,
            limitSharing: {
                sharingLimited: message.limitSharing === true,
                trigger: 1,
                limitSharingSettingTimestamp: Date.now(),
                initiatedByMe: true
            }
        };
    }
    else {
        m = await prepareWAMessageMedia(message, options);
    }
    if (hasOptionalProperty(message, 'viewOnce') && !!message.viewOnce) {
        m = { viewOnceMessage: { message: m } };
    }
    if ((hasOptionalProperty(message, 'mentions') && message.mentions?.length) ||
        (hasOptionalProperty(message, 'mentionAll') && message.mentionAll)) {
        const richContextTarget = m?.botForwardedMessage?.message?.richResponseMessage
            || m?.viewOnceMessage?.message?.botForwardedMessage?.message?.richResponseMessage;
        const messageType = Object.keys(m).find(name => name !== 'messageContextInfo') || Object.keys(m)[0];
        const key = richContextTarget || m[messageType];
        if (key && 'contextInfo' in key) {
            key.contextInfo = key.contextInfo || {};
            if (message.mentions?.length) {
                key.contextInfo.mentionedJid = message.mentions;
            }
            if (message.mentionAll) {
                key.contextInfo.nonJidMentions = 1;
            }
        }
        else if (key) {
            key.contextInfo = {
                mentionedJid: message.mentions,
                nonJidMentions: message.mentionAll ? 1 : 0
            };
        }
    }
    if (hasOptionalProperty(message, 'edit')) {
        m = {
            protocolMessage: {
                key: message.edit,
                editedMessage: m,
                timestampMs: Date.now(),
                type: WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT
            }
        };
    }
    if (hasOptionalProperty(message, 'contextInfo') && !!message.contextInfo) {
        const richContextTarget = m?.botForwardedMessage?.message?.richResponseMessage
            || m?.viewOnceMessage?.message?.botForwardedMessage?.message?.richResponseMessage;
        const messageType = Object.keys(m).find(name => name !== 'messageContextInfo') || Object.keys(m)[0];
        const key = richContextTarget || m[messageType];
        if (key && 'contextInfo' in key && !!key.contextInfo) {
            key.contextInfo = { ...key.contextInfo, ...message.contextInfo };
        }
        else if (key) {
            key.contextInfo = message.contextInfo;
        }
    }
    if (hasOptionalProperty(message, 'albumParentKey') && !!message.albumParentKey) {
        m.messageContextInfo = {
            ...m.messageContextInfo,
            messageAssociation: {
                associationType: WAProto.MessageAssociation.AssociationType.MEDIA_ALBUM,
                parentMessageKey: message.albumParentKey
            }
        };
    }
    if (shouldIncludeReportingToken(m)) {
        m.messageContextInfo = m.messageContextInfo || {};
        if (!m.messageContextInfo.messageSecret) {
            m.messageContextInfo.messageSecret = randomBytes(32);
        }
    }
    return WAProto.Message.create(m);
};
export const generateWAMessageFromContent = (jid, message, options) => {
    // set timestamp to now
    // if not specified
    if (!options.timestamp) {
        options.timestamp = new Date();
    }
    const innerMessage = normalizeMessageContent(message);
    const key = getContentType(innerMessage);
    const timestamp = unixTimestampSeconds(options.timestamp);
    const { quoted, userJid } = options;
    if (quoted && !isJidNewsletter(jid)) {
        const participant = quoted.key.fromMe
            ? userJid // TODO: Add support for LIDs
            : quoted.participant || quoted.key.participant || quoted.key.remoteJid;
        let quotedMsg = normalizeMessageContent(quoted.message);
        const msgType = getContentType(quotedMsg);
        // strip any redundant properties
        quotedMsg = proto.Message.create({ [msgType]: quotedMsg[msgType] });
        const quotedContent = quotedMsg[msgType];
        if (typeof quotedContent === 'object' && quotedContent && 'contextInfo' in quotedContent) {
            delete quotedContent.contextInfo;
        }
        const contextInfo = ('contextInfo' in innerMessage[key] && innerMessage[key]?.contextInfo) || {};
        contextInfo.participant = jidNormalizedUser(participant);
        contextInfo.stanzaId = quoted.key.id;
        contextInfo.quotedMessage = quotedMsg;
        // if a participant is quoted, then it must be a group
        // hence, remoteJid of group must also be entered
        if (jid !== quoted.key.remoteJid) {
            contextInfo.remoteJid = quoted.key.remoteJid;
        }
        if (contextInfo && innerMessage[key]) {
            /* @ts-ignore */
            innerMessage[key].contextInfo = contextInfo;
        }
    }
    if (
    // if we want to send a disappearing message
    !!options?.ephemeralExpiration &&
        // and it's not a protocol message -- delete, toggle disappear message
        key !== 'protocolMessage' &&
        // already not converted to disappearing message
        key !== 'ephemeralMessage' &&
        // newsletters don't support ephemeral messages
        !isJidNewsletter(jid)) {
        /* @ts-ignore */
        innerMessage[key].contextInfo = {
            ...(innerMessage[key].contextInfo || {}),
            expiration: options.ephemeralExpiration || WA_DEFAULT_EPHEMERAL
            //ephemeralSettingTimestamp: options.ephemeralOptions.eph_setting_ts?.toString()
        };
    }
    message = WAProto.Message.create(message);
    const messageJSON = {
        key: {
            remoteJid: jid,
            fromMe: true,
            id: options?.messageId || generateMessageIDV2()
        },
        message: message,
        messageTimestamp: timestamp,
        messageStubParameters: [],
        participant: isJidGroup(jid) || isJidStatusBroadcast(jid) ? userJid : undefined, // TODO: Add support for LIDs
        status: WAMessageStatus.PENDING
    };
    return WAProto.WebMessageInfo.fromObject(messageJSON);
};
export const generateWAMessage = async (jid, content, options) => {
    // ensure msg ID is with every log
    options.logger = options?.logger?.child({ msgId: options.messageId });
    // Pass jid in the options to generateWAMessageContent
    return generateWAMessageFromContent(jid, await generateWAMessageContent(content, { ...options, jid }), options);
};
/** Get the key to access the true type of content */
export const getContentType = (content) => {
    if (content) {
        const keys = Object.keys(content);
        const key = keys.find(k => (k === 'conversation' || k.includes('Message')) && k !== 'senderKeyDistributionMessage');
        return key;
    }
};
/**
 * Normalizes ephemeral, view once messages to regular message content
 * Eg. image messages in ephemeral messages, in view once messages etc.
 * @param content
 * @returns
 */
export const normalizeMessageContent = (content) => {
    if (!content) {
        return undefined;
    }
    // set max iterations to prevent an infinite loop
    for (let i = 0; i < 5; i++) {
        const inner = getFutureProofMessage(content);
        if (!inner) {
            break;
        }
        content = inner.message;
    }
    return content;
    function getFutureProofMessage(message) {
        return (message?.ephemeralMessage ||
            message?.viewOnceMessage ||
            message?.documentWithCaptionMessage ||
            message?.viewOnceMessageV2 ||
            message?.viewOnceMessageV2Extension ||
            message?.editedMessage ||
            message?.associatedChildMessage ||
            message?.groupStatusMessage ||
            message?.groupStatusMessageV2);
    }
};
/**
 * Extract the true message content from a message
 * Eg. extracts the inner message from a disappearing message/view once message
 */
export const extractMessageContent = (content) => {
    const extractFromTemplateMessage = (msg) => {
        if (msg.imageMessage) {
            return { imageMessage: msg.imageMessage };
        }
        else if (msg.documentMessage) {
            return { documentMessage: msg.documentMessage };
        }
        else if (msg.videoMessage) {
            return { videoMessage: msg.videoMessage };
        }
        else if (msg.locationMessage) {
            return { locationMessage: msg.locationMessage };
        }
        else {
            return {
                conversation: 'contentText' in msg ? msg.contentText : 'hydratedContentText' in msg ? msg.hydratedContentText : ''
            };
        }
    };
    content = normalizeMessageContent(content);
    if (content?.buttonsMessage) {
        return extractFromTemplateMessage(content.buttonsMessage);
    }
    if (content?.templateMessage?.hydratedFourRowTemplate) {
        return extractFromTemplateMessage(content?.templateMessage?.hydratedFourRowTemplate);
    }
    if (content?.templateMessage?.hydratedTemplate) {
        return extractFromTemplateMessage(content?.templateMessage?.hydratedTemplate);
    }
    if (content?.templateMessage?.fourRowTemplate) {
        return extractFromTemplateMessage(content?.templateMessage?.fourRowTemplate);
    }
    return content;
};
/**
 * Returns the device predicted by message ID
 */
export const getDevice = (id) => /^3A.{18}$/.test(id)
    ? 'ios'
    : /^3E.{20}$/.test(id)
        ? 'web'
        : /^(.{21}|.{32})$/.test(id)
            ? 'android'
            : /^(3F|.{18}$)/.test(id)
                ? 'desktop'
                : 'wa bot';
/** Upserts a receipt in the message */
export const updateMessageWithReceipt = (msg, receipt) => {
    msg.userReceipt = msg.userReceipt || [];
    const recp = msg.userReceipt.find(m => m.userJid === receipt.userJid);
    if (recp) {
        Object.assign(recp, receipt);
    }
    else {
        msg.userReceipt.push(receipt);
    }
};
/** Update the message with a new reaction */
export const updateMessageWithReaction = (msg, reaction) => {
    const authorID = getKeyAuthor(reaction.key);
    const reactions = (msg.reactions || []).filter(r => getKeyAuthor(r.key) !== authorID);
    reaction.text = reaction.text || '';
    reactions.push(reaction);
    msg.reactions = reactions;
};
/** Update the message with a new poll update */
export const updateMessageWithPollUpdate = (msg, update) => {
    const authorID = getKeyAuthor(update.pollUpdateMessageKey);
    const reactions = (msg.pollUpdates || []).filter(r => getKeyAuthor(r.pollUpdateMessageKey) !== authorID);
    if (update.vote?.selectedOptions?.length) {
        reactions.push(update);
    }
    msg.pollUpdates = reactions;
};
/** Update the message with a new event response */
export const updateMessageWithEventResponse = (msg, update) => {
    const authorID = getKeyAuthor(update.eventResponseMessageKey);
    const responses = (msg.eventResponses || []).filter(r => getKeyAuthor(r.eventResponseMessageKey) !== authorID);
    responses.push(update);
    msg.eventResponses = responses;
};
/**
 * Aggregates all poll updates in a poll.
 * @param msg the poll creation message
 * @param meId your jid
 * @returns A list of options & their voters
 */
export function getAggregateVotesInPollMessage({ message, pollUpdates }, meId) {
    const opts = message?.pollCreationMessage?.options ||
        message?.pollCreationMessageV2?.options ||
        message?.pollCreationMessageV3?.options ||
        [];
    const voteHashMap = opts.reduce((acc, opt) => {
        const hash = sha256(Buffer.from(opt.optionName || '')).toString();
        acc[hash] = {
            name: opt.optionName || '',
            voters: []
        };
        return acc;
    }, {});
    for (const update of pollUpdates || []) {
        const { vote } = update;
        if (!vote) {
            continue;
        }
        for (const option of vote.selectedOptions || []) {
            const hash = option.toString();
            let data = voteHashMap[hash];
            if (!data) {
                voteHashMap[hash] = {
                    name: 'Unknown',
                    voters: []
                };
                data = voteHashMap[hash];
            }
            voteHashMap[hash].voters.push(getKeyAuthor(update.pollUpdateMessageKey, meId));
        }
    }
    return Object.values(voteHashMap);
}
/**
 * Aggregates all event responses in an event message.
 * @param msg the event creation message
 * @param meId your jid
 * @returns A list of response types & their responders
 */
export function getAggregateResponsesInEventMessage({ eventResponses }, meId) {
    const responseTypes = ['GOING', 'NOT_GOING', 'MAYBE'];
    const responseMap = {};
    for (const type of responseTypes) {
        responseMap[type] = {
            response: type,
            responders: []
        };
    }
    for (const update of eventResponses || []) {
        const responseType = update.eventResponse || 'UNKNOWN';
        if (responseType !== 'UNKNOWN' && responseMap[responseType]) {
            responseMap[responseType].responders.push(getKeyAuthor(update.eventResponseMessageKey, meId));
        }
    }
    return Object.values(responseMap);
}
/** Given a list of message keys, aggregates them by chat & sender. Useful for sending read receipts in bulk */
export const aggregateMessageKeysNotFromMe = (keys) => {
    const keyMap = {};
    for (const { remoteJid, id, participant, fromMe } of keys) {
        if (!fromMe) {
            const uqKey = `${remoteJid}:${participant || ''}`;
            if (!keyMap[uqKey]) {
                keyMap[uqKey] = {
                    jid: remoteJid,
                    participant: participant,
                    messageIds: []
                };
            }
            keyMap[uqKey].messageIds.push(id);
        }
    }
    return Object.values(keyMap);
};
const REUPLOAD_REQUIRED_STATUS = [410, 404];
/**
 * Downloads the given message. Throws an error if it's not a media message
 */
export const downloadMediaMessage = async (message, type, options, ctx) => {
    const result = await downloadMsg().catch(async (error) => {
        if (ctx &&
            typeof error?.status === 'number' && // treat errors with status as HTTP failures requiring reupload
            REUPLOAD_REQUIRED_STATUS.includes(error.status)) {
            ctx.logger.info({ key: message.key }, 'sending reupload media request...');
            // request reupload
            message = await ctx.reuploadRequest(message);
            const result = await downloadMsg();
            return result;
        }
        throw error;
    });
    return result;
    async function downloadMsg() {
        const mContent = extractMessageContent(message.message);
        if (!mContent) {
            throw new Boom('No message present', { statusCode: 400, data: message });
        }
        const contentType = getContentType(mContent);
        let mediaType = contentType?.replace('Message', '');
        const media = mContent[contentType];
        if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) {
            throw new Boom(`"${contentType}" message is not a media message`);
        }
        let download;
        if ('thumbnailDirectPath' in media && !('url' in media)) {
            download = {
                directPath: media.thumbnailDirectPath,
                mediaKey: media.mediaKey
            };
            mediaType = 'thumbnail-link';
        }
        else {
            download = media;
        }
        const stream = await downloadContentFromMessage(download, mediaType, options);
        if (type === 'buffer') {
            const bufferArray = [];
            for await (const chunk of stream) {
                bufferArray.push(chunk);
            }
            return Buffer.concat(bufferArray);
        }
        return stream;
    }
};
/** Checks whether the given message is a media message; if it is returns the inner content */
export const assertMediaContent = (content) => {
    content = extractMessageContent(content);
    const mediaContent = content?.documentMessage ||
        content?.imageMessage ||
        content?.videoMessage ||
        content?.audioMessage ||
        content?.stickerMessage;
    if (!mediaContent) {
        throw new Boom('given message is not a media message', { statusCode: 400, data: content });
    }
    return mediaContent;
};
//# sourceMappingURL=messages.js.map