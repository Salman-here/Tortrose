'use strict';
const fs=require('fs');
const path=require('path');
const source=fs.readFileSync(path.resolve(__dirname,'../../services/whatsapp/webhookHandler.js'),'utf8');
const section=source.slice(source.indexOf('const sendResponseMessage ='),source.indexOf('const sendLockedMessage ='));

test.each([true,false])('decision reply %s reports the decision without inventing cart or fulfillment state',async confirmed=>{
  const sendText=jest.fn().mockResolvedValue({});
  const send=new Function('evolution','console',section.replace('const sendResponseMessage =','return'))({sendText},{log:()=>{},error:()=>{}});
  await send('+12025550116',confirmed,'ORD-123','Test Buyer');
  expect(sendText).toHaveBeenCalledTimes(1);
  const text=sendText.mock.calls[0][1];
  expect(text).toContain(confirmed?'is confirmed':'has been cancelled');
  expect(text).not.toMatch(/cart is still saved|nothing is charged|packing it up now/);
  if(confirmed)expect(text).toContain('each seller prepares and ships');
  else expect(text).toContain('place a new order at rozare.com');
});
