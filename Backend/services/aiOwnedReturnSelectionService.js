'use strict';
const id=v=>String(v?._id||v||'');
const normalized=v=>String(v||'').trim().toLowerCase();
const plainOptions=value=>value instanceof Map?Object.fromEntries(value):value?.toObject?value.toObject({flattenMaps:true}):value||{};
const formatOwnedReturnItem=item=>{
 const entries=Object.entries(plainOptions(item.selectedOptions));
 return `${item.quantity} × ${item.name}${entries.length?' ('+entries.map(([key,value])=>`${key}: ${value}`).join(', ')+')':item.selectedColor?' ('+item.selectedColor+')':''}`;
};
const fail=()=>Object.assign(new Error('Choose the exact item and variant from this owned order\'s return eligibility list.'),{code:'AI_COMMERCE_ITEM_AMBIGUOUS',statusCode:409});
const escape=v=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function matchesFriendlyName(name,item){
 const base=normalized(item.name),supplied=normalized(name);
 if(supplied===base)return true;
 if(!supplied.startsWith(base)||!/[\s(),:/—-]/.test(supplied.charAt(base.length)))return false;
 let suffix=supplied.slice(base.length);
 const terms=[...Object.keys(plainOptions(item.selectedOptions)),...Object.values(plainOptions(item.selectedOptions)),item.selectedColor].filter(Boolean).map(normalized).sort((a,b)=>b.length-a.length);
 for(const term of terms)suffix=suffix.replace(new RegExp(`\\b${escape(term)}\\b`,'g'),' ');
 return !suffix.replace(/\b(?:in|with|variant|option|color|colour|size)\b/g,'').replace(/[\s(),:/—-]+/g,'');
}
function resolveOwnedReturnSelection(selection,ownedItems){
 const supplied=id(selection.orderItemId),named=normalized(selection.itemName);
 const line=supplied&&ownedItems.find(i=>id(i.orderItemId)===supplied);
 let candidates=line?[line]:supplied?ownedItems.filter(i=>id(i.productId)===supplied):ownedItems;
 // Recover model-memory ids only against this current actor-owned order group.
 // The canonical return service still checks eligibility, quantity and money.
 if(!line&&(!supplied||!candidates.length)&&named)candidates=ownedItems.filter(i=>matchesFriendlyName(named,i));
 else if(named)candidates=candidates.filter(i=>matchesFriendlyName(named,i));
 if(selection.selectedColor)candidates=candidates.filter(i=>normalized(i.selectedColor||plainOptions(i.selectedOptions).Color)===normalized(selection.selectedColor));
 if(selection.selectedOptions&&typeof selection.selectedOptions==='object'&&!Array.isArray(selection.selectedOptions)){
  for(const [key,value]of Object.entries(plainOptions(selection.selectedOptions)))candidates=candidates.filter(i=>{
   const entry=Object.entries(plainOptions(i.selectedOptions)).find(([k])=>normalized(k)===normalized(key));
   return entry&&normalized(entry[1])===normalized(value);
  });
 }
 if(candidates.length!==1){
  const error=fail();
  error.safeReturnSelectionRecovery={nextTool:'get_return_eligibility',receivedSelector:{orderItemId:selection.orderItemId,itemName:selection.itemName,selectedColor:selection.selectedColor,selectedOptions:selection.selectedOptions},
   ownedChoices:ownedItems.map(i=>({orderItemId:id(i.orderItemId),productId:id(i.productId),name:i.name,selectedColor:i.selectedColor,selectedOptions:plainOptions(i.selectedOptions),eligible:i.eligible}))};
  throw error;
 }
 return {orderItemId:id(candidates[0].orderItemId),quantity:selection.quantity};
}
module.exports={resolveOwnedReturnSelection,plainOptions,formatOwnedReturnItem};
