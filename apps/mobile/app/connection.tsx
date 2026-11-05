// Screen 3b — Shop Connection (shows the 4 independent connection states)
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import type { ConnectionState } from "@inklink/shared-schemas";
import { Screen, Heading, Body, Button, Card, Pill } from "@/components/ui";
import { spacing } from "@/theme";
import { useApp } from "@/state/app-context";
import { appConfig } from "@/config";

export default function Connection() {
  const router = useRouter();
  const { connection, session, api } = useApp();
  const [state, setState] = useState<ConnectionState>(connection.snapshot);

  async function probeAll() {
    await connection.probeGateway(api.origin);
    await connection.probeInternet();
    // Internet and cloud are different things; skip the cloud probe until one is provisioned.
    if (appConfig.cloudOrigin) await connection.probeCloud(`${appConfig.cloudOrigin}/health`);
  }

  useEffect(() => {
    const unsub = connection.subscribe(setState);
    void probeAll();
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  return (
    <Screen>
      <Heading>{session.shop?.shopId ?? "Unknown shop"}</Heading>
      <Body muted>Shop key {session.shop?.publicKeyFingerprint ?? "—"}</Body>
      <Body muted>Gateway {api.isConfigured ? api.origin : "—"}</Body>
      <View style={{ height: spacing.md }} />

      <Card>
        <StateRow label="Shop identified" ok={state.shopIdentified} />
        <StateRow label="Local gateway reachable" ok={state.localGatewayReachable} />
        <StateRow label="Internet available" ok={state.internetAvailable} />
        <StateRow label="Cloud backend available" ok={state.cloudApiAvailable} />
      </Card>

      <Body muted>Basic printing only needs the local gateway. Internet and cloud are optional.</Body>

      <Button label="Continue" disabled={!state.localGatewayReachable} onPress={() => router.push("/document")} />
      {!state.localGatewayReachable ? (
        <Button label="Retry gateway" variant="secondary" onPress={() => void probeAll()} />
      ) : null}
    </Screen>
  );
}

function StateRow({ label, ok }: { label: string; ok: boolean }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: spacing.sm }}>
      <Body>{label}</Body>
      <Pill text={ok ? "yes" : "no"} tone={ok ? "good" : "bad"} />
    </View>
  );
}
