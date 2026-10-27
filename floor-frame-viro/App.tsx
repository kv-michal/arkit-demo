import { useEffect, useState } from "react";
import {
  AppState,
  Linking,
  Pressable,
  PixelRatio,
  type LayoutChangeEvent,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { useCameraPermissions } from "expo-camera";
import { StatusBar } from "expo-status-bar";
import { ViroARSceneNavigator } from "@reactvision/react-viro";
import { FloorScene } from "./src/ARScene";
import { settingsStore, placement, uiStore } from "./src/placement";
import { DiagnosticsPanel } from "./src/DiagnosticsPanel";
import { diagnostics } from "./src/diagnostics";

function updateAimLayout(event: LayoutChangeEvent) {
  placement.setAimLayout(event.nativeEvent.layout, PixelRatio.get());
}

const INITIAL_SCENE = { scene: FloorScene };
const GRADIENT = [
  "rgba(0,0,0,0.65)",
  "transparent",
  "rgba(0,0,0,0.65)",
] as const;
function FloorFrame() {
  const insets = useSafeAreaInsets();
  const settings = settingsStore.useValue();
  const [permission, requestPermission] = useCameraPermissions();
  const [active, setActive] = useState(AppState.currentState === "active");
  const granted = permission?.granted === true;
  const denied = permission?.status === "denied";

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      diagnostics.record("app_state", { state }, true);
      setActive(state === "active");
      if (state !== "active") placement.suspend();
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (permission?.status === "undetermined") void requestPermission();
  }, [permission?.status, requestPermission]);
  useEffect(() => {
    diagnostics.record("camera_permission", { status: permission?.status, granted: permission?.granted, canAskAgain: permission?.canAskAgain }, true);
  }, [permission?.status, permission?.granted, permission?.canAskAgain]);
  useEffect(() => {
    diagnostics.record("renderer_settings_committed", {
      depthEnabled: settings.depth, worldMeshEnabled: settings.depth,
      occlusionMode: settings.occlusion ? "depthBased" : "disabled",
      sessionId: settings.sessionId, cameraGranted: granted, active,
      worldAlignment: "Gravity", provider: "none", videoQuality: "High",
    }, true);
  }, [settings.depth, settings.occlusion, settings.sessionId, granted, active]);
  useEffect(() => {
    if (!granted || !active) return;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await placement.sample();
      } finally {
        inFlight = false;
      }
    };
    // Match Swift's 20 Hz preview budget without overlapping Viro hit tests.
    const timer = setInterval(() => {
      void poll();
    }, 50);
    void poll();
    return () => {
      clearInterval(timer);
      placement.suspend();
    };
  }, [granted, active]);

  return (
    <View style={s.root}>
      <StatusBar style="light" />
      {granted ? (
        <View style={StyleSheet.absoluteFill}>
          <ViroARSceneNavigator
            key={settings.sessionId}
            ref={placement.attachNavigator}
            initialScene={INITIAL_SCENE}
            worldAlignment="Gravity"
            autofocus
            videoQuality="High"
            provider="none"
            depthEnabled={settings.depth}
            worldMeshEnabled={settings.depth}
            occlusionMode={settings.occlusion ? "depthBased" : "disabled"}
            hdrEnabled
            pbrEnabled
            bloomEnabled={false}
            shadowsEnabled={false}
            multisamplingEnabled
          />
        </View>
      ) : null}
      <LinearGradient
        colors={GRADIENT}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View
        pointerEvents="box-none"
        style={[
          s.overlay,
          { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 },
        ]}
      >
        <Header granted={granted} />
        <View style={s.spacer} onLayout={updateAimLayout} pointerEvents="none">
          <Target />
        </View>
        <PlacementControls granted={granted} denied={denied} />
      </View>
    </View>
  );
}
function Target() {
  const { ready, locked } = uiStore.useValue();
  return (
    <View pointerEvents="none" style={s.target}>
      <Text style={[s.crosshair, (ready || locked) && s.mint]}>
        {locked ? "⊕" : "+"}
      </Text>
    </View>
  );
}
function Header({ granted }: { granted: boolean }) {
  const ui = uiStore.useValue();
  return (
    <View style={s.header}>
      <View>
        <Text style={s.title}>FLOOR FRAME</Text>
        <Text style={s.subtitle}>
          {ui.locked ? "FIXED IN YOUR SPACE" : "SURFACE PREVIEW"}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Reset scan"
        testID="reset"
        disabled={ui.busy || !granted}
        onPress={() => void placement.configure(ui.depth)}
        style={s.reset}
      >
        <Text style={s.resetIcon}>↻</Text>
      </Pressable>
    </View>
  );
}
function PlacementControls({
  granted,
  denied,
}: {
  granted: boolean;
  denied: boolean;
}) {
  const ui = uiStore.useValue();
  return (
    <BlurView intensity={75} tint="systemMaterialDark" style={s.card}>
      <View style={s.status} testID="placementStatus">
        <Text style={s.message}>
          {denied ? "Camera access is required" : ui.message}
        </Text>
        <Text style={s.detail}>
          {denied ? "Allow camera access in Settings to use AR" : ui.detail}
        </Text>
      </View>
      <View
        style={s.picker}
        accessibilityRole="radiogroup"
        accessibilityLabel="Rectangle width"
      >
        <WidthButton large={false} selected={!ui.large} />
        <WidthButton large selected={ui.large} />
      </View>
      <RectangleCountControl />
      <View style={s.modeRow}>
        <Text style={[s.modeLabel, s.modeText]}>Follow anchor updates</Text>
        <Switch
          accessibilityLabel="Follow anchor updates"
          testID="followAnchorToggle"
          value={ui.followAnchorUpdates}
          onValueChange={placement.setFollowAnchorUpdates}
          disabled={ui.busy}
          trackColor={{ true: "#63e6c4" }}
        />
      </View>
      <OcclusionControl granted={granted} />
      <ModeControl granted={granted} />
      <Text style={s.dimensions}>
        {ui.large ? "3 × 1.35 × 1.5 m" : "20 × 9 × 10 cm"}
      </Text>
      <AnchorButton granted={granted} denied={denied} />
      <DiagnosticsPanel />
    </BlurView>
  );
}
function RectangleCountControl() {
  const { rectangleCount } = uiStore.useValue();
  return (
    <View style={s.modeRow} testID="rectangleCountStepper">
      <Text style={[s.modeLabel, s.modeText]}>
        Rectangles: {rectangleCount}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Decrease rectangle count"
        disabled={rectangleCount <= 1}
        onPress={() => placement.setRectangleCount(rectangleCount - 1)}
        style={[s.countButton, rectangleCount <= 1 && s.disabled]}
      >
        <Text style={s.segmentText}>−</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Increase rectangle count"
        disabled={rectangleCount >= 51}
        onPress={() => placement.setRectangleCount(rectangleCount + 1)}
        style={[s.countButton, rectangleCount >= 51 && s.disabled]}
      >
        <Text style={s.segmentText}>+</Text>
      </Pressable>
    </View>
  );
}
function OcclusionControl({ granted }: { granted: boolean }) {
  const ui = uiStore.useValue();
  return (
    <View style={s.modeRow}>
      <Text style={[s.modeLabel, s.modeText]}>Occlusion</Text>
      <Switch
        accessibilityLabel="Occlusion"
        testID="occlusionToggle"
        value={ui.occlusion}
        onValueChange={(value) => void placement.setOcclusion(value)}
        disabled={ui.busy || !granted}
        trackColor={{ true: "#63e6c4" }}
      />
    </View>
  );
}
function ModeControl({ granted }: { granted: boolean }) {
  const ui = uiStore.useValue();
  const description = ui.depth
    ? "LiDAR when available · Viro depth + mesh"
    : ui.occlusion
      ? "Depth active for occlusion"
      : "Standard Viro plane detection";
  return (
    <View style={s.modeRow}>
      <View style={s.modeText}>
        <Text style={s.modeLabel}>Viro depth + mesh</Text>
        <Text style={s.small}>{description}</Text>
      </View>
      <Switch
        accessibilityLabel="Viro depth + mesh"
        testID="depthToggle"
        value={ui.depth}
        onValueChange={(depth) => placement.configure(depth)}
        disabled={ui.locked || ui.busy || !granted}
        trackColor={{ true: "#63e6c4" }}
      />
    </View>
  );
}
function AnchorButton({
  granted,
  denied,
}: {
  granted: boolean;
  denied: boolean;
}) {
  const ui = uiStore.useValue();
  const title = denied
    ? "Open Camera Settings"
    : ui.locked
      ? "Reposition"
      : "Anchor rectangle";
  const disabled =
    !denied && (!granted || ui.busy || (!ui.locked && !ui.ready));
  function onPress() {
    if (denied) void Linking.openSettings();
    else void placement.anchorOrReposition();
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      testID="anchorButton"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.anchor,
        disabled && s.disabled,
        pressed && s.pressed,
      ]}
    >
      <Text style={s.anchorText}>{title}</Text>
    </Pressable>
  );
}
function WidthButton({
  large,
  selected,
}: {
  large: boolean;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={large ? "3 m wide" : "20 cm wide"}
      testID={large ? "widthLarge" : "widthSmall"}
      onPress={() => placement.setWidth(large)}
      style={[s.segment, selected && s.selected]}
    >
      <Text style={s.segmentText}>{large ? "3 m wide" : "20 cm wide"}</Text>
    </Pressable>
  );
}
export default function App() {
  return (
    <SafeAreaProvider>
      <FloorFrame />
    </SafeAreaProvider>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#081317" },
  overlay: { flex: 1, paddingHorizontal: 20 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { color: "white", fontSize: 17, fontWeight: "700", letterSpacing: 2 },
  subtitle: {
    color: "#ffffffa6",
    fontSize: 10,
    letterSpacing: 1.5,
    marginTop: 3,
  },
  reset: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#ffffff20",
    alignItems: "center",
    justifyContent: "center",
  },
  resetIcon: { fontSize: 30, color: "white" },
  spacer: { flex: 1 },
  target: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  crosshair: { color: "white", fontSize: 32, fontWeight: "200" },
  mint: { color: "#63e6c4" },
  card: {
    alignSelf: "center",
    width: "100%",
    maxWidth: 440,
    borderRadius: 26,
    overflow: "hidden",
    padding: 20,
    gap: 14,
    backgroundColor: "#20232955",
  },
  status: { alignItems: "center", gap: 5 },
  message: {
    fontSize: 15,
    fontWeight: "600",
    color: "white",
    textAlign: "center",
  },
  detail: { fontSize: 12, color: "#b8b8bf", textAlign: "center" },
  picker: {
    height: 32,
    backgroundColor: "#10101488",
    borderRadius: 8,
    padding: 2,
    flexDirection: "row",
  },
  segment: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  selected: { backgroundColor: "#63636b" },
  segmentText: { color: "white", fontSize: 13, fontWeight: "500" },
  countButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffffff20",
    borderRadius: 8,
  },
  modeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  modeText: { flex: 1, gap: 3 },
  modeLabel: { color: "white", fontSize: 15, fontWeight: "500" },
  small: { fontSize: 12, color: "#b8b8bf" },
  dimensions: {
    color: "#b8b8bf",
    fontSize: 12,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  anchor: {
    backgroundColor: "#63e6c4",
    borderRadius: 12,
    minHeight: 50,
    justifyContent: "center",
    alignItems: "center",
  },
  anchorText: { fontSize: 17, fontWeight: "600", color: "#000" },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.75 },
});
