import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider } from "@/state/app-context";
import { colors } from "@/theme";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.paperWhite },
            headerTintColor: colors.signalOrange,
            headerTitleStyle: { fontWeight: "700", color: colors.inkBlack },
            headerShadowVisible: false,
            headerBackButtonDisplayMode: "minimal",
            contentStyle: { backgroundColor: colors.paperWhite },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="discovery" options={{ title: "Find a Shop" }} />
          <Stack.Screen name="scan" options={{ title: "Scan Shop QR" }} />
          <Stack.Screen name="connection" options={{ title: "Shop Connection" }} />
          <Stack.Screen name="document" options={{ title: "Select Document" }} />
          <Stack.Screen name="configure" options={{ title: "Print Settings" }} />
          <Stack.Screen name="preview" options={{ title: "Review Job" }} />
          <Stack.Screen name="payment" options={{ title: "Payment" }} />
          <Stack.Screen name="authorize" options={{ title: "Authorize Agent" }} />
          <Stack.Screen name="payment-status" options={{ title: "Payment" }} />
          <Stack.Screen name="tracking" options={{ title: "Print Job" }} />
          <Stack.Screen name="history" options={{ title: "History" }} />
          <Stack.Screen name="settings" options={{ title: "Settings" }} />
        </Stack>
      </AppProvider>
    </SafeAreaProvider>
  );
}
