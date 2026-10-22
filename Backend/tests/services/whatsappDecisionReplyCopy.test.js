'use strict';
const fs=require('fs');
const path=require('path');
const source=fs.readFileSync(path.resolve(__dirname,'../../services/whatsapp/webhookHandler.js'),'utf8');
const section=source.slice(source.indexOf('const sendResponseMessage ='),source.indexOf('const sendLockedMessage ='));

test('confirmation reply reports the decision without inventing cart or fulfillment state',async()=>{
  const sendText=jest.fn().mockResolvedValue({});
  const send=new Function('evolution','console',section.replace('const sendResponseMessage =','return'))({sendText},{log:()=>{},error:()=>{}});
  await send('+12025550116',true,'ORD-123','Test Buyer');
  expect(sendText).toHaveBeenCalledTimes(1);
  const text=sendText.mock.calls[0][1];
  expect(text).toContain('is confirmed');
  expect(text).not.toMatch(/cart is still saved|nothing is charged|packing it up now/);
  expect(text).toContain('updates as your items are prepared and shipped');
});

test('successful cancellation leaves delivery to the durable status notice without a duplicate acknowledgement',async()=>{
  const sendText=jest.fn().mockResolvedValue({});
  const send=new Function('evolution','console',section.replace('const sendResponseMessage =','return'))({sendText},{log:()=>{},error:()=>{}});
  await send('+12025550116',false,'ORD-123','Test Buyer');
  expect(sendText).not.toHaveBeenCalled();
});
