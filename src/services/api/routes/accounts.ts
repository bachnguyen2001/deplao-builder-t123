/**
 * Accounts group: list, status, connect/disconnect, proxy.
 * IPC channels: login:getAccounts, login:checkHealth, login:connect, login:disconnect,
 * fb:connect, fb:disconnect, fb:checkHealth, telegramUser:startListener, telegramUser:isConnected,
 * proxy:getForAccount, proxy:setAccount, proxy:list.
 */
import { randomUUID } from 'node:crypto';
import EventBroadcaster from '../../event/EventBroadcaster';
import { s } from '../schema';
import { ApiError, route, RouteDef } from '../types';
import { accountAllowed } from '../auth/ApiAuth';
import { CHANNELS } from '../channels/ChannelActions';
import { accountParams, scrub } from './common';
import { tr } from '../../../shared/i18n';

const accountSchema = s.object({
    id: s.string(), channel: s.string(), display_name: s.string(), avatar_url: s.string(), phone: s.string(),
    online: s.boolean(), is_business: s.boolean(), listener_active: s.boolean(),
    created_at: s.any().nullable(), last_seen: s.any().nullable(),
});

function maskProxy(p: any): any {
    if (!p || typeof p !== 'object') return p;
    const { password, ...rest } = p;
    return { ...scrub(rest), has_password: !!password };
}

async function rawAccount(ctx: any, accountId: string): Promise<any> {
    const res = await ctx.call('login:getAccounts');
    return (res?.accounts || []).find((a: any) => String(a.zalo_id) === String(accountId)) || null;
}

interface QrSessionState {
    status: string;
    qrDataUrl: string;
    message?: string;
    accountId?: string;
    accountName?: string;
    updatedAt: number;
}

const qrSessions = new Map<string, QrSessionState>();
const QR_SESSION_TTL_MS = 15 * 60_000;

/** Apply one `qr:update` payload to the session store. Pure (no I/O), returns the new status or null if ignored. */
export function applyQrUpdate(sessions: Map<string, QrSessionState>, data: any, now: number): string | null {
    const tempId = String(data?.tempId || '');
    if (!tempId) return null;
    const prev = sessions.get(tempId);
    const status = String(data?.status || prev?.status || 'waiting');
    sessions.set(tempId, {
        status,
        qrDataUrl: data?.qrDataUrl ? String(data.qrDataUrl) : (prev?.qrDataUrl || ''),
        message: data?.message ? String(data.message) : undefined,
        accountId: data?.zaloId ? String(data.zaloId) : prev?.accountId,
        accountName: data?.displayName ? String(data.displayName) : prev?.accountName,
        updatedAt: now,
    });
    const cutoff = now - QR_SESSION_TTL_MS;
    for (const [k, v] of sessions) {
        if (v.updatedAt < cutoff) sessions.delete(k);
    }
    return status;
}

/** Named so EventBroadcaster.onBeforeSend dedupes it (same reference) and rehooking is idempotent. */
function onQrUpdate(data: any): void {
    if (applyQrUpdate(qrSessions, data, Date.now()) !== 'success') return;
    try {
        // Lazy require: ApiPlatform imports the routes, so a top-level import would be circular.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('../ApiPlatform').default.getInstance().invalidateAccounts();
    } catch { /* the account list refreshes on its own after 3 s */ }
}

/**
 * (Re)register the QR hook. Call at startup and after a workspace switch: clearBeforeSendHooks() removes every hook,
 * and without this all QR sessions stay at 'initializing'. Safe to call any number of times.
 */
export function rehookQrSessions(): void {
    EventBroadcaster.onBeforeSend('qr:update', onQrUpdate);
}

export function accountRoutes(): RouteDef[] {
    rehookQrSessions();
    return [
        route({
            method: 'GET', path: '/accounts', scope: 'accounts:read', tags: ['Tài khoản'], operationId: 'listAccounts',
            summary: tr('Danh sách tài khoản (Zalo, Facebook, Telegram) mà key được phép'),
            query: s.object({
                channel: s.enum(['zalo', 'facebook', 'telegram_user', 'telegram_bot'] as const).optional().describe(tr('Lọc theo kênh')),
                online: s.boolean().optional().describe(tr('Chỉ tài khoản đang online')),
            }),
            response: s.array(accountSchema),
            handler: async ctx => {
                const list = await ctx.listAccounts();
                return list
                    .filter((a: any) => accountAllowed(ctx.principal, a.id))
                    .filter((a: any) => !ctx.query.channel || a.channel === ctx.query.channel)
                    .filter((a: any) => ctx.query.online === undefined || a.online === ctx.query.online);
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId', scope: 'accounts:read', tags: ['Tài khoản'], operationId: 'getAccount',
            summary: tr('Thông tin một tài khoản'),
            params: accountParams,
            response: accountSchema,
            handler: ctx => ctx.account(ctx.params.accountId),
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/status', scope: 'accounts:read', tags: ['Tài khoản'], operationId: 'getAccountStatus',
            summary: tr('Trạng thái kết nối/listener chi tiết và proxy đang dùng'),
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                let health: any = null;
                try {
                    if (acc.channel === CHANNELS.ZALO) {
                        const res = await ctx.call('login:checkHealth', { zaloIds: [acc.id] });
                        health = res?.results?.[0] || null;
                    } else if (acc.channel === CHANNELS.FACEBOOK) {
                        health = await ctx.call('fb:checkHealth', { accountId: acc.id });
                    } else if (acc.channel === CHANNELS.TELEGRAM_USER) {
                        health = await ctx.ipc('telegramUser:isConnected', acc.id);
                    }
                } catch (err: any) {
                    health = { error: err?.message || String(err) };
                }
                let proxy: any = null;
                try {
                    const p = await ctx.call('proxy:getForAccount', { zaloId: acc.id });
                    proxy = maskProxy(p?.proxy ?? null);
                } catch { proxy = null; }
                return { account: acc, health: scrub(health), proxy };
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/connect', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'connectAccount',
            summary: tr('Kết nối lại tài khoản bằng phiên đã lưu'),
            description: tr('Dùng phiên đăng nhập đã lưu trên máy (không nhận cookie từ client). Zalo: login:connect; Facebook: fb:connect; Telegram: telegramUser:startListener.'),
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel === CHANNELS.FACEBOOK) {
                    const r = await ctx.call('fb:connect', { accountId: acc.id }, { timeoutMs: 120_000 });
                    return { connected: true, listener_connected: !!r?.listenerConnected };
                }
                const raw = await rawAccount(ctx, acc.id);
                if (!raw) throw new ApiError(404, 'NOT_FOUND', tr('Không tìm thấy phiên đăng nhập đã lưu'));
                if (acc.channel === CHANNELS.TELEGRAM_USER) {
                    if (!raw.cookies) throw new ApiError(409, 'CONFLICT', tr('Phiên Telegram không còn, cần đăng nhập lại trên app'));
                    await ctx.call('telegramUser:startListener', { accountId: acc.id, phoneNumber: '', stringSession: raw.cookies }, { timeoutMs: 120_000 });
                    return { connected: true };
                }
                if (acc.channel === CHANNELS.ZALO) {
                    await ctx.call('login:connect', {
                        auth: { cookies: raw.cookies || '', imei: raw.imei || '', userAgent: raw.user_agent || '' },
                    }, { timeoutMs: 120_000 });
                    return { connected: true };
                }
                throw new ApiError(422, 'CHANNEL_UNSUPPORTED', tr('Kênh {{channel}} chưa hỗ trợ kết nối qua API', { channel: acc.channel }));
            },
        }),
        route({
            method: 'POST', path: '/accounts/:accountId/disconnect', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'disconnectAccount',
            summary: tr('Ngắt kết nối tài khoản (giữ dữ liệu)'),
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel === CHANNELS.FACEBOOK) await ctx.call('fb:disconnect', { accountId: acc.id });
                else await ctx.call('login:disconnect', { zaloId: acc.id });
                return { disconnected: true };
            },
        }),
        route({
            method: 'GET', path: '/accounts/:accountId/proxy', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'getAccountProxy',
            summary: tr('Proxy đang gán cho tài khoản (không trả mật khẩu)'),
            params: accountParams,
            handler: async ctx => {
                await ctx.account(ctx.params.accountId);
                const res = await ctx.call('proxy:getForAccount', { zaloId: ctx.params.accountId });
                return maskProxy(res?.proxy ?? null);
            },
        }),
        route({
            method: 'PUT', path: '/accounts/:accountId/proxy', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'setAccountProxy',
            summary: tr('Gán proxy (id trong danh sách proxy) hoặc bỏ proxy (null)'),
            params: accountParams,
            body: s.object({ proxy_id: s.int().nullable().describe(tr('ID proxy từ GET /proxies; null = bỏ proxy')) }),
            handler: async ctx => {
                await ctx.account(ctx.params.accountId);
                await ctx.call('proxy:setAccount', { zaloId: ctx.params.accountId, proxyId: ctx.body.proxy_id ?? null });
                return { proxy_id: ctx.body.proxy_id ?? null };
            },
        }),
        route({
            method: 'GET', path: '/proxies', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'listProxies',
            summary: tr('Danh sách proxy đã cấu hình (không trả mật khẩu)'),
            handler: async ctx => {
                const res = await ctx.call('proxy:list');
                const list = Array.isArray(res) ? res : (res?.proxies || res?.items || []);
                return list.map(maskProxy);
            },
        }),
        route({
            method: 'POST', path: '/accounts/zalo/qr', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'startZaloQrLogin',
            summary: tr('Bắt đầu phiên đăng nhập Zalo bằng mã QR'),
            body: s.object({ proxy_id: s.int().nullable().optional() }).optional(),
            handler: async ctx => {
                rehookQrSessions();
                const tempId = randomUUID();
                qrSessions.set(tempId, { status: 'initializing', qrDataUrl: '', updatedAt: Date.now() });
                const res = await ctx.call('login:qr', { tempId, proxyId: ctx.body?.proxy_id ?? null });
                if (res && res.success === false) {
                    throw new ApiError(500, 'QR_START_FAILED', res.error || tr('Không thể khởi tạo mã QR'));
                }
                return { temp_id: tempId };
            },
        }),
        route({
            method: 'GET', path: '/accounts/zalo/qr/:tempId', scope: 'accounts:read', tags: ['Tài khoản'], operationId: 'getZaloQrStatus',
            summary: tr('Lấy mã QR và trạng thái phiên đăng nhập Zalo'),
            params: s.object({ tempId: s.string() }),
            handler: async ctx => {
                const state = qrSessions.get(ctx.params.tempId);
                if (!state) throw new ApiError(404, 'NOT_FOUND', tr('Không tìm thấy phiên QR'));
                return {
                    temp_id: ctx.params.tempId,
                    status: state.status,
                    qr_data_url: state.qrDataUrl,
                    message: state.message ?? null,
                    account_id: state.accountId ?? null,
                    account_name: state.accountName ?? null,
                };
            },
        }),
        route({
            method: 'POST', path: '/accounts/zalo/qr/:tempId/abort', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'abortZaloQrLogin',
            summary: tr('Hủy phiên đăng nhập Zalo bằng mã QR'),
            params: s.object({ tempId: s.string() }),
            handler: async ctx => {
                await ctx.call('login:qr:abort', { tempId: ctx.params.tempId }).catch(() => {});
                qrSessions.delete(ctx.params.tempId);
                return { aborted: true };
            },
        }),
        route({
            method: 'DELETE', path: '/accounts/:accountId', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'removeAccount',
            summary: tr('Xóa tài khoản và phiên đăng nhập khỏi engine'),
            params: accountParams,
            handler: async ctx => {
                const acc = await ctx.account(ctx.params.accountId);
                if (acc.channel === CHANNELS.FACEBOOK) {
                    await ctx.call('fb:removeAccount', { accountId: acc.id });
                } else {
                    await ctx.call('login:removeAccount', { zaloId: acc.id, deleteData: true });
                }
                return { removed: true, account_id: acc.id };
            },
        }),
        route({
            method: 'POST', path: '/accounts/facebook/login', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'loginFacebookCredentials',
            summary: tr('Đăng nhập Facebook Messenger bằng tài khoản/mật khẩu (hỗ trợ 2FA)'),
            body: s.object({
                username: s.string().min(1),
                password: s.string().min(1),
                two_fa_secret: s.string().optional(),
            }),
            handler: async ctx => {
                const res = await ctx.call('fb:loginWithCredentials', {
                    username: ctx.body.username,
                    password: ctx.body.password,
                    twoFASecret: ctx.body.two_fa_secret,
                }, { timeoutMs: 120_000 });
                if (!res?.success) {
                    throw new ApiError(400, 'FB_LOGIN_FAILED', res?.error || res?.result?.error || tr('Đăng nhập Facebook thất bại'));
                }
                return { success: true, account: scrub(res.result || res) };
            },
        }),
        route({
            method: 'POST', path: '/accounts/telegram/send-code', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'telegramSendCode',
            summary: tr('Gửi mã OTP đăng nhập Telegram User'),
            body: s.object({ phone_number: s.string().min(4) }),
            handler: async ctx => {
                const res = await ctx.ipc('telegramUser:sendCode', ctx.body.phone_number, { timeoutMs: 60_000 });
                if (res && res.success === false) {
                    throw new ApiError(400, 'TELEGRAM_SEND_CODE_FAILED', res.error || tr('Không gửi được mã OTP Telegram'));
                }
                return scrub(res);
            },
        }),
        route({
            method: 'POST', path: '/accounts/telegram/sign-in', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'telegramSignIn',
            summary: tr('Xác nhận mã OTP đăng nhập Telegram User'),
            body: s.object({
                phone_number: s.string().min(4),
                code: s.string().min(1),
                phone_code_hash: s.string().min(1),
            }),
            handler: async ctx => {
                const res = await ctx.call('telegramUser:signIn', {
                    phoneNumber: ctx.body.phone_number,
                    code: ctx.body.code,
                    phoneCodeHash: ctx.body.phone_code_hash,
                }, { timeoutMs: 60_000 });
                if (res && res.success === false && !res.needs2FA) {
                    throw new ApiError(400, 'TELEGRAM_SIGN_IN_FAILED', res.error || tr('Đăng nhập Telegram thất bại'));
                }
                return scrub(res);
            },
        }),
        route({
            method: 'POST', path: '/accounts/telegram/sign-in-2fa', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'telegramSignIn2FA',
            summary: tr('Xác nhận mật khẩu 2FA khi đăng nhập Telegram User'),
            body: s.object({ password: s.string().min(1) }),
            handler: async ctx => {
                const res = await ctx.ipc('telegramUser:signIn2FA', ctx.body.password, { timeoutMs: 60_000 });
                if (res && res.success === false) {
                    throw new ApiError(400, 'TELEGRAM_2FA_FAILED', res.error || tr('Mật khẩu 2FA Telegram không đúng'));
                }
                return scrub(res);
            },
        }),
        route({
            method: 'POST', path: '/accounts/telegram/bot', scope: 'accounts:manage', tags: ['Tài khoản'], operationId: 'telegramConnectBot',
            summary: tr('Kết nối Telegram Bot bằng Bot Token'),
            body: s.object({ bot_token: s.string().min(10) }),
            handler: async ctx => {
                const check = await ctx.ipc('telegram:validateBot', ctx.body.bot_token, { timeoutMs: 30_000 });
                if (!check?.success || !check?.account) {
                    throw new ApiError(400, 'TELEGRAM_BOT_INVALID', check?.error || tr('Bot Token không hợp lệ'));
                }
                const start = await ctx.call('telegram:startBot', check.account, { timeoutMs: 30_000 });
                if (start && start.success === false) {
                    throw new ApiError(409, 'TELEGRAM_BOT_CONFLICT', start.error || tr('Không thể khởi động Bot'));
                }
                return { success: true, account: scrub(check.account) };
            },
        }),
    ];
}
