/**
 * AIChatScreen — Full-screen AI Chat
 * Wraps the existing ChatBot component in a permanent route. Role-aware.
 */

import React from 'react';
import { View, StyleSheet, SafeAreaView } from 'react-native';
import ChatBot from '../components/ChatBot';
import GlassBackground from '../components/common/GlassBackground';
import { useAuth } from '../contexts/AuthContext';

export default function AIChatScreen({ navigation, route }) {
  const { currentUser } = useAuth();
  const role = route?.params?.role || currentUser?.role || 'user';

  return (
    <GlassBackground>
      <SafeAreaView style={styles.container}>
        <ChatBot
          embedded={true}
          visible={true}
          dashboardRole={role}
          onClose={() => navigation.goBack()}
          navigation={navigation}
        />
      </SafeAreaView>
    </GlassBackground>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
