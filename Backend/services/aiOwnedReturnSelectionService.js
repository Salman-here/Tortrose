'use strict';
const id=v=>String(v?._id||v||'');
const normalized=v=>String(v||'').trim().toLowerCase();
const fail=()=>Object.assign(new Error('Choose the exact item and variant from this owned order\'s return eligibility list.'),{code:'AI_COMMERCE_ITEM_AMBIGUOUS',statusCode:409});
function resolveOwnedReturnSelection(selection,ownedItems){
 const supplied=id(selection.orderItemId),named=normalized(selection.itemName);
 const line=supplied&&ownedItems.find(i=>id(i.orderItemId)===supplied);
 let candidates=line?[line]:supplied?ownedItems.filter(i=>id(i.productId)===supplied):ownedItems;
 // Recover model-memory ids only against this current actor-owned order group.
 // The canonical return service still checks eligibility, quantity and money.
 if(!line&&(!supplied||!candidates.length)&&named)candidates=ownedItems.filter(i=>normalized(i.name)===named);
 else if(named)candidates=candidates.filter(i=>normalized(i.name)===named);
 if(selection.selectedColor)candidates=candidates.filter(i=>normalized(i.selectedColor||i.selectedOptions?.Color)===normalized(selection.selectedColor));
 if(selection.selectedOptions&&typeof selection.selectedOptions==='object'&&!Array.isArray(selection.selectedOptions)){
  for(const [key,value]of Object.entries(selection.selectedOptions))candidates=candidates.filter(i=>{
   const entry=Object.entries(i.selectedOptions||{}).find(([k])=>normalized(k)===normalized(key));
   return entry&&normalized(entry[1])===normalized(value);
  });
 }
 if(candidates.length!==1)throw fail();
 return {orderItemId:id(candidates[0].orderItemId),quantity:selection.quantity};
}
module.exports={resolveOwnedReturnSelection};
