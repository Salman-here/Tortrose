/**
 * AIChatScreen — Full-screen AI Chat
 * Wraps the existing ChatBot component in a permanent route. Role-aware.
 */

import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ChatBot from '../components/ChatBot';
import GlassBackground from '../components/common/GlassBackground';
import { useAuth } from '../contexts/AuthContext';

export default function AIChatScreen({ navigation, route }) {
  const { currentUser } = useAuth();
  const role = route?.params?.role || currentUser?.role || 'user';
  const handoff = route?.params?.handoff || null;
  const initialPrompt = handoff?.prompt || route?.params?.prompt || '';
  const handleBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('MainTabs', { screen: 'Home' });
  };

  return (
    <GlassBackground contentMaxWidth={900}>
      <SafeAreaView style={styles.container} edges={Platform.OS === 'android' ? [] : ['top']}>
        <ChatBot
          embedded={true}
          visible={true}
          dashboardRole={role}
          onClose={handleBack}
          navigation={navigation}
          initialPrompt={initialPrompt}
          handoffRequest={handoff}
          onHandoffConsumed={id => { if (route?.params?.handoff?.id === id) navigation.setParams({ handoff: null, prompt: '' }); }}
        />
      </SafeAreaView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
