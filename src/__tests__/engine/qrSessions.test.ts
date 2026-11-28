const hooks = new Map<string, Array<(d: any) => void>>();
jest.mock('../../services/event/EventBroadcaster', () => ({
    __esModule: true,
    default: {
        onBeforeSend: (channel: string, cb: (d: any) => void) => {   // mimics the real dedupe-by-reference
            const arr = hooks.get(channel) ?? [];
            if (!arr.includes(cb)) arr.push(cb);
            hooks.set(channel, arr);
            return () => hooks.set(channel, (hooks.get(channel) ?? []).filter(f => f !== cb));
        },
    },
}));
const invalidateAccounts = jest.fn();
jest.mock('../../services/api/ApiPlatform', () => ({
    __esModule: true,
    default: { getInstance: () => ({ invalidateAccounts }) },
}));
import { accountRoutes, applyQrUpdate, rehookQrSessions } from '../../services/api/routes/accounts';

const emit = (data: any) => (hooks.get('qr:update') ?? []).forEach(cb => cb(data));
const byOp = (op: string) => accountRoutes().find(r => r.operationId === op)!;
const ctx = (extra: any) => ({ call: jest.fn().mockResolvedValue({ success: true }), body: {}, params: {}, ...extra }) as any;

async function start() {
    const c = ctx({});
    const res = await byOp('startZaloQrLogin').handler(c);
    return { c, tempId: res.temp_id as string };
}
const status = (tempId: string) => byOp('getZaloQrStatus').handler(ctx({ params: { tempId } }));

beforeEach(() => {
    hooks.clear();
    invalidateAccounts.mockClear();
    rehookQrSessions();
});

test('start returns temp_id and status initializing', async () => {
    const { c, tempId } = await start();
    expect(tempId).toBeTruthy();
    expect(c.call).toHaveBeenCalledWith('login:qr', { tempId, proxyId: null });
    expect((await status(tempId)).status).toBe('initializing');
});

test('waiting then success carries account', async () => {
    const { tempId } = await start();
    emit({ tempId, status: 'waiting', qrDataUrl: 'data:image/png;base64,QQ==' });
    const waiting = await status(tempId);
    expect(waiting.status).toBe('waiting');
    expect(waiting.qr_data_url).toBe('data:image/png;base64,QQ==');
    emit({ tempId, status: 'success', qrDataUrl: '', zaloId: '758', displayName: 'BQL A' });
    const done = await status(tempId);
    expect(done.status).toBe('success');
    expect(done.account_id).toBe('758');
    expect(done.account_name).toBe('BQL A');
    expect(done.qr_data_url).toBe('data:image/png;base64,QQ==');
    expect(invalidateAccounts).toHaveBeenCalledTimes(1);
});

test('rehook after clearBeforeSendHooks keeps sessions updating', async () => {
    const { tempId } = await start();
    hooks.clear();   // simulates a workspace switch
    emit({ tempId, status: 'waiting', qrDataUrl: 'data:image/png;base64,QQ==' });
    expect((await status(tempId)).status).toBe('initializing');
    rehookQrSessions();
    emit({ tempId, status: 'waiting', qrDataUrl: 'data:image/png;base64,QQ==' });
    expect((await status(tempId)).status).toBe('waiting');
});

test('rehook is idempotent', () => {
    rehookQrSessions();
    rehookQrSessions();
    rehookQrSessions();
    expect(hooks.get('qr:update')!.length).toBe(1);
});

test('abort removes the session', async () => {
    const { tempId } = await start();
    expect(await byOp('abortZaloQrLogin').handler(ctx({ params: { tempId } }))).toEqual({ aborted: true });
    await expect(status(tempId)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
});

test('applyQrUpdate prunes old sessions and ignores missing tempId', () => {
    const map = new Map<string, any>([['old', { status: 'waiting', qrDataUrl: '', updatedAt: 0 }]]);
    expect(applyQrUpdate(map, { tempId: 'new', status: 'waiting' }, 16 * 60_000)).toBe('waiting');
    expect(map.has('old')).toBe(false);
    expect(applyQrUpdate(map, {}, 1)).toBeNull();
});
