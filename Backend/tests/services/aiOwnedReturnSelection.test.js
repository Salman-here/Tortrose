'use strict';
const {resolveOwnedReturnSelection:resolve}=require('../../services/aiOwnedReturnSelectionService');
const rows=[{orderItemId:'line-a5',productId:'product-1',name:'QA Notebook',selectedColor:'Blue',selectedOptions:{Color:'Blue',Size:'A5'}},
 {orderItemId:'line-a6',productId:'product-1',name:'QA Notebook',selectedColor:'Blue',selectedOptions:{Color:'Blue',Size:'A6'}}];
test('uses an exact owned order line id',()=>expect(resolve({orderItemId:'line-a6',quantity:1},rows)).toEqual({orderItemId:'line-a6',quantity:1}));
test('product ids resolve only unique lines in the owned order',()=>expect(resolve({orderItemId:'product-1',quantity:1},[rows[1]])).toEqual({orderItemId:'line-a6',quantity:1}));
test('product ids with multiple variants require a variant choice',()=>expect(()=>resolve({orderItemId:'product-1',quantity:1},rows)).toThrow('exact item and variant'));
test('product ids and selected variants resolve to the correct line',()=>expect(resolve({orderItemId:'product-1',selectedOptions:{Size:'A6',Color:'Blue'},quantity:1},rows)).toEqual({orderItemId:'line-a6',quantity:1}));
test('stale model ids recover only from unique owned friendly selectors',()=>expect(resolve({orderItemId:'old-order-line',itemName:'QA Notebook',selectedOptions:{Size:'A6'},quantity:1},rows)).toEqual({orderItemId:'line-a6',quantity:1}));
test('unknown ids without owned friendly selectors cannot target another order',()=>expect(()=>resolve({orderItemId:'foreign-line',quantity:1},rows)).toThrow('exact item and variant'));
test('known line ids cannot override conflicting selected variants',()=>expect(()=>resolve({orderItemId:'line-a5',selectedOptions:{Size:'A6'},quantity:1},rows)).toThrow('exact item and variant'));
test('friendly names and variants resolve without exposing ids',()=>expect(resolve({itemName:'qa notebook',selectedColor:'blue',selectedOptions:{size:'a6'},quantity:1},rows)).toEqual({orderItemId:'line-a6',quantity:1}));
