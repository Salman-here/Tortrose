import React from 'react';
import {render,fireEvent,waitFor} from '@testing-library/react-native';
import CartVariantsDialog from '../../src/components/CartVariantsDialog';
import {replaceGuestVariant} from '../../src/utils/editCartVariant';
const mockEdit=jest.fn(),mockAdd=jest.fn(),mockQty=jest.fn();
const product={_id:'p',name:'Color mug',stock:10,optionGroups:[{name:'Color',values:['Red','White','Yellow']}]};
const red={_id:'r',product,qty:2,selectedColor:'Red',selectedOptions:{Color:'Red'}};
const mockRed=red;
jest.mock('../../src/contexts/GlobalContext',()=>({useGlobal:()=>({cartItems:{cart:[mockRed]},handleEditCartVariant:mockEdit,handleAddToCart:mockAdd,handleQtyInc:mockQty,handleQtyDec:mockQty,handleRemoveCartItem:mockQty})}));
jest.mock('../../src/contexts/ThemeContext',()=>({useTheme:()=>({palette:require('../../src/styles/palettes').lightPalette})}));
jest.mock('../../src/components/common/AppModal',()=>({visible,children})=>visible?children:null);
jest.mock('../../src/components/common/GlassPanel',()=>({children})=>children);
jest.mock('expo-image',()=>({Image:require('react-native').Image}));
jest.mock('expo-linear-gradient',()=>({LinearGradient:require('react-native').View}));
jest.mock('@expo/vector-icons',()=>({Ionicons:()=>null}));
jest.mock('react-native-safe-area-context',()=>({useSafeAreaInsets:()=>({top:24,bottom:20,left:0,right:0})}));
jest.mock('../../src/components/common/ProductOptionsModal',()=>{const ReactModule=require('react'),{Text,TouchableOpacity}=require('react-native');return ({title,confirmLabel,onConfirm,error})=>ReactModule.createElement(ReactModule.Fragment,null,ReactModule.createElement(Text,null,title),ReactModule.createElement(Text,null,error),ReactModule.createElement(TouchableOpacity,{accessibilityLabel:confirmLabel,onPress:()=>onConfirm({selectedColor:'White',selectedOptions:{Color:'White'}})},ReactModule.createElement(Text,null,confirmLabel)));});
beforeEach(()=>{jest.clearAllMocks();mockEdit.mockResolvedValue(true);mockAdd.mockResolvedValue(true);});
test('editing calls the replacement endpoint, never the add action',async()=>{const screen=render(<CartVariantsDialog open product={product} onClose={jest.fn()}/>);fireEvent.press(screen.getByLabelText('Edit Red'));fireEvent.press(screen.getByLabelText('Save changes'));await waitFor(()=>expect(mockEdit).toHaveBeenCalledWith(red,product,{selectedColor:'White',selectedOptions:{Color:'White'}}));expect(mockAdd).not.toHaveBeenCalled();});
test('another color explicitly uses the separate add action',async()=>{const screen=render(<CartVariantsDialog open product={product} onClose={jest.fn()}/>);fireEvent.press(screen.getByLabelText('+ Add another variant'));fireEvent.press(screen.getByLabelText('Add variant to cart'));await waitFor(()=>expect(mockAdd).toHaveBeenCalledWith('p','White',{Color:'White'},product,'add'));expect(mockEdit).not.toHaveBeenCalled();});

test('successful add closes instead of opening a second dialog',async()=>{const close=jest.fn();const screen=render(<CartVariantsDialog open product={product} onClose={close}/>);fireEvent.press(screen.getByLabelText('+ Add another variant'));fireEvent.press(screen.getByLabelText('Add variant to cart'));await waitFor(()=>expect(close).toHaveBeenCalledTimes(1));});

test('successful edit closes while preserving the replacement action',async()=>{const close=jest.fn();const screen=render(<CartVariantsDialog open product={product} onClose={close}/>);fireEvent.press(screen.getByLabelText('Edit Red'));fireEvent.press(screen.getByLabelText('Save changes'));await waitFor(()=>expect(close).toHaveBeenCalledTimes(1));expect(mockAdd).not.toHaveBeenCalled();});
test('failed edits show an inline error and preserve the editing form',async()=>{mockEdit.mockRejectedValue(new Error('The item changed. Refresh your bag.'));const screen=render(<CartVariantsDialog open product={product} onClose={jest.fn()}/>);fireEvent.press(screen.getByLabelText('Edit Red'));fireEvent.press(screen.getByLabelText('Save changes'));await waitFor(()=>expect(screen.getByText('The item changed. Refresh your bag.')).toBeTruthy());expect(screen.getByText('Edit variant')).toBeTruthy();});
test('guest variants merge while preserving all units',()=>{const white={...red,_id:'w',qty:3,selectedColor:'White',selectedOptions:{Color:'White'}};const result=replaceGuestVariant([red,white],red,product,{selectedColor:'White',selectedOptions:{Color:'White'}},'merged');expect(result).toHaveLength(1);expect(result[0].qty).toBe(5);});
