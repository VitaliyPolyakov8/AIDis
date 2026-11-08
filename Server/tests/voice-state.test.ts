import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectSocket, createTestEnv, createUser, listen, login, waitForEvent, type LoginResult, type TestEnv } from './helpers.js';

interface VoiceState {
  userId: string;
  deafened: boolean;
}

describe('voice deafen state', () => {
  let env: TestEnv;
  let baseUrl: string;
  let alice: LoginResult;
  let bob: LoginResult;

  beforeAll(async () => {
    env = await createTestEnv();
    await createUser(env, 'Alice');
    await createUser(env, 'Bob');
    alice = await login(env, 'Alice');
    bob = await login(env, 'Bob');
    baseUrl = await listen(env);
  });

  afterAll(async () => {
    await env.close();
  });

  it('broadcasts deafen changes, sends a snapshot on connect and clears the state on disconnect', async () => {
    const aliceSocket = connectSocket(baseUrl, alice.accessToken);
    const bobSocket = connectSocket(baseUrl, bob.accessToken);
    const bobSnapshot = waitForEvent<{ deafened: string[] }>(bobSocket, 'voice.states');
    await Promise.all([waitForEvent(aliceSocket, 'ready'), waitForEvent(bobSocket, 'ready')]);
    expect((await bobSnapshot).deafened).toEqual([]);

    const on = waitForEvent<VoiceState>(bobSocket, 'voice.state');
    aliceSocket.emit('voice.state', { deafened: true });
    expect(await on).toMatchObject({ userId: alice.user.id, deafened: true });

    // A late joiner learns the current state from the snapshot.
    const late = connectSocket(baseUrl, bob.accessToken);
    const lateSnapshot = waitForEvent<{ deafened: string[] }>(late, 'voice.states');
    expect((await lateSnapshot).deafened).toEqual([alice.user.id]);
    late.close();

    const off = waitForEvent<VoiceState>(bobSocket, 'voice.state');
    aliceSocket.emit('voice.state', { deafened: false });
    expect(await off).toMatchObject({ userId: alice.user.id, deafened: false });

    // Invalid payloads are ignored; dropping the connection clears a deafened state.
    aliceSocket.emit('voice.state', { deafened: 'yes' });
    aliceSocket.emit('voice.state', { deafened: true });
    expect(await waitForEvent<VoiceState>(bobSocket, 'voice.state')).toMatchObject({ userId: alice.user.id, deafened: true });
    const cleared = waitForEvent<VoiceState>(bobSocket, 'voice.state');
    aliceSocket.close();
    expect(await cleared).toMatchObject({ userId: alice.user.id, deafened: false });
    bobSocket.close();
  });
});
