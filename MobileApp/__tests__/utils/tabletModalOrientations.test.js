import { getModalOrientations } from '../../src/components/common/AppModal';
test('iPad popup orientation follows the iPad native configuration', () => {
  expect(getModalOrientations('ios', true)).toEqual(['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']);
});
test('phone and Android popup defaults remain unchanged and explicit callers retain control', () => {
  expect(getModalOrientations('ios', false)).toBeUndefined();
  expect(getModalOrientations('android', false)).toBeUndefined();
  expect(getModalOrientations('ios', true, ['portrait'])).toEqual(['portrait']);
});
