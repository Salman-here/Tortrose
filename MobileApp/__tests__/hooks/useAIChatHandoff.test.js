import React, { act } from 'react';
import TestRenderer from 'react-test-renderer';
import { readFileSync } from 'fs';
import { useAIChatHandoff } from '../../src/hooks/useAIChatHandoff';
let root;
const Probe = props => { useAIChatHandoff(props); return null; };
const update = async props => act(async () => { if (root) root.update(<Probe {...props}/>); else root = TestRenderer.create(<Probe {...props}/>); await Promise.resolve(); });
afterEach(() => { if (root) act(() => root.unmount()); root = null; });
test('waits for history, sends once and permits a fresh click for the same question', async () => {
  const send = jest.fn().mockResolvedValue(), consumed = jest.fn();
  const props = { request: { id: 'first', prompt: 'Tell me about this item', actorKey: 'buyer' }, actorKey: 'buyer', ready: false, busy: false, send, consumed };
  await update(props); expect(send).not.toHaveBeenCalled();
  await update({ ...props, ready: true, busy: true }); expect(send).not.toHaveBeenCalled();
  await update({ ...props, ready: true }); expect(send).toHaveBeenCalledTimes(1); expect(consumed).toHaveBeenCalledWith('first');
  await update({ ...props, ready: true }); expect(send).toHaveBeenCalledTimes(1);
  await update({ ...props, ready: true, request: { ...props.request, id: 'second' } }); expect(send).toHaveBeenCalledTimes(2);
});
test('does not send a previous account intent after login or account switch', async () => {
  const send = jest.fn(), consumed = jest.fn();
  await update({ request: { id: 'old', prompt: 'Review my bag', actorKey: 'owner-a' }, actorKey: 'owner-b', ready: true, busy: false, send, consumed });
  expect(send).not.toHaveBeenCalled(); expect(consumed).toHaveBeenCalledWith('old');
});
test('handles a failed start without repeating the request', async () => {
  const send = jest.fn().mockRejectedValue(new Error('offline')), failed = jest.fn();
  const props = { request: { id: 'failure', prompt: 'Question', actorKey: 'guest' }, actorKey: 'guest', ready: true, busy: false, send, failed };
  await update(props); await update(props);
  expect(send).toHaveBeenCalledTimes(1); expect(failed).toHaveBeenCalledWith('Question');
});
test('web and mobile use the identical handoff gate', () => {
  const path = require('path');
  const mobile = readFileSync(path.resolve(__dirname, '../../src/hooks/useAIChatHandoff.js'), 'utf8').replace(/\r\n/g, '\n');
  const web = readFileSync(path.resolve(__dirname, '../../../Frontend/src/hooks/useAIChatHandoff.js'), 'utf8').replace(/\r\n/g, '\n');
  expect(web).toBe(mobile);
});
