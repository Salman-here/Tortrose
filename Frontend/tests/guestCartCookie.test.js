import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeGuestCartCookie, parseGuestCartCookie } from '../src/utils/guestCartCookie.js';
const product={_id:'p',name:'Color mug',stock:20,price:100,currency:'PKR',priceCurrency:'PKR',description:'Large catalogue details '.repeat(500),moderationReason:'audit metadata '.repeat(100),optionGroups:[{name:'Color',values:['Red','Yellow','White']}]};
const cart=['Red','Yellow','White'].map((color,index)=>({product,qty:index+1,selectedColor:color,selectedOptions:{Color:color}}));
test('three colors share one compact product snapshot instead of exceeding cookie capacity',()=>{assert(JSON.stringify(cart).length>4096);const cookie=serializeGuestCartCookie(cart);assert(encodeURIComponent(cookie).length<3500);const parsed=parseGuestCartCookie(cookie);assert.deepEqual(parsed.map(line=>[line.selectedColor,line.qty]),[['Red',1],['Yellow',2],['White',3]]);assert.equal(Object.keys(JSON.parse(cookie).products).length,1);});
test('legacy cookie arrays remain readable and unlike variants remain distinct',()=>{assert.equal(parseGuestCartCookie(JSON.stringify(cart)).length,3);assert.equal(serializeGuestCartCookie(parseGuestCartCookie(serializeGuestCartCookie(cart))),serializeGuestCartCookie(cart));});
test('oversized guest bags fail before writing or silently losing any items',()=>{const large=Array.from({length:50},(_,index)=>({...cart[0],product:{...product,_id:'product-'+index,name:'A long catalogue name '.repeat(10)}}));assert.throws(()=>serializeGuestCartCookie(large),/Sign in/);assert.equal(large.length,50);});
