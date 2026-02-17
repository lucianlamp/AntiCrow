// ---------------------------------------------------------------------------
// errors.test.ts — カスタムエラークラステスト
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
    BridgeError,
    CdpConnectionError,
    CdpCommandError,
    CdpTargetNotFoundError,
    AntigravityLaunchError,
    CascadePanelError,
} from '../errors';

describe('Custom Error Classes', () => {
    it('BridgeError should be instanceof Error', () => {
        const err = new BridgeError('test error');
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(BridgeError);
        expect(err.name).toBe('BridgeError');
        expect(err.message).toBe('test error');
    });

    it('CdpConnectionError should extend BridgeError', () => {
        const err = new CdpConnectionError('connection failed', 9222);
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(BridgeError);
        expect(err).toBeInstanceOf(CdpConnectionError);
        expect(err.name).toBe('CdpConnectionError');
        expect(err.port).toBe(9222);
    });

    it('CdpCommandError should extend BridgeError', () => {
        const err = new CdpCommandError('timeout', 'Runtime.evaluate');
        expect(err).toBeInstanceOf(BridgeError);
        expect(err).toBeInstanceOf(CdpCommandError);
        expect(err.name).toBe('CdpCommandError');
        expect(err.method).toBe('Runtime.evaluate');
    });

    it('CdpTargetNotFoundError should have targetId', () => {
        const err = new CdpTargetNotFoundError('not found', 'target-123');
        expect(err).toBeInstanceOf(BridgeError);
        expect(err.name).toBe('CdpTargetNotFoundError');
        expect(err.targetId).toBe('target-123');
    });

    it('AntigravityLaunchError should extend BridgeError', () => {
        const err = new AntigravityLaunchError('launch failed');
        expect(err).toBeInstanceOf(BridgeError);
        expect(err.name).toBe('AntigravityLaunchError');
    });

    it('CascadePanelError should extend BridgeError', () => {
        const err = new CascadePanelError('panel not found');
        expect(err).toBeInstanceOf(BridgeError);
        expect(err.name).toBe('CascadePanelError');
    });

    it('errors should have proper stack traces', () => {
        const err = new CdpConnectionError('stack test');
        expect(err.stack).toBeTruthy();
        expect(err.stack!).toContain('CdpConnectionError');
    });
});
