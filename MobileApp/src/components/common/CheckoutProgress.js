import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { CHECKOUT_STEPS } from '../../utils/checkoutProgress';

export default function CheckoutProgress({ currentStep, onStepPress, disabled = false }) {
  const { palette } = useTheme();
  return (
    <View style={styles.row} accessibilityRole="tablist">
      {CHECKOUT_STEPS.map((label, index) => {
        const selected = index === currentStep, complete = index < currentStep;
        const unavailable = disabled || index > currentStep;
        return (
          <React.Fragment key={label}>
            {index > 0 && <View style={[styles.line, { backgroundColor: complete || selected ? palette.colors.primary : palette.glass.borderSubtle }]} />}
            <TouchableOpacity
              accessibilityRole="tab" accessibilityLabel={`Step ${index + 1} of 3, ${label}`}
              accessibilityState={{ selected, disabled: unavailable }} disabled={unavailable}
              onPress={() => onStepPress(index)} style={styles.step}
            >
              <View style={[styles.circle, { backgroundColor: selected || complete ? palette.colors.primary : palette.glass.bgSubtle,
                borderColor: selected || complete ? palette.colors.primary : palette.glass.borderSubtle }]}>
                {complete ? <Ionicons name="checkmark" size={16} color="#fff" />
                  : <Text style={[styles.number, { color: selected ? '#fff' : palette.colors.textSecondary }]}>{index + 1}</Text>}
              </View>
              <Text style={[styles.label, { color: selected || complete ? palette.colors.text : palette.colors.textSecondary }]}>{label}</Text>
            </TouchableOpacity>
          </React.Fragment>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, paddingTop: 16, paddingBottom: 8 },
  step: { alignItems: 'center', minWidth: 64, minHeight: 60, gap: 5 },
  circle: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  number: { fontSize: 13, fontWeight: '700' },
  label: { fontSize: 12, fontWeight: '600' },
  line: { flex: 1, height: 2, marginBottom: 22, marginHorizontal: 6 },
});
