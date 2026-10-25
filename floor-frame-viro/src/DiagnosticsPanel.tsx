import { useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { diagnostics } from "./diagnostics";
import { placement } from "./placement";

export function DiagnosticsPanel() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("Recording automatically while AR is active");

  function capture(event: string) {
    diagnostics.record(event, placement.debugSnapshot(), true);
    return diagnostics.export();
  }
  function show() { setSnapshot(capture("log_opened")); setOpen(true); }
  function mark() {
    diagnostics.record("USER_MARKED_SINKING", placement.debugSnapshot(), true);
    setFeedback("Sinking marked with current placement and timestamp");
    Alert.alert("Sinking marked", "Timestamp and current placement saved. Use Debug logs to copy or share the capture.");
  }
  async function copy() {
    setBusy(true);
    try {
      diagnostics.record("log_copy", placement.debugSnapshot(), true);
      // Android clipboard/binder has payload limits. Keep complete JSONL
      // records and recent pinned events; Share always exports the full buffer.
      const text = diagnostics.export(350_000);
      await Clipboard.setStringAsync(text);
      const header: { exportTruncated: boolean } = JSON.parse(text.split("\n", 1)[0]);
      setFeedback(header.exportTruncated ? "Recent log copied. Use Share log for the full capture." : "Full log copied");
    } catch (error) { Alert.alert("Could not copy log", String(error)); }
    finally { setBusy(false); }
  }
  async function share() {
    setBusy(true);
    try {
      if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing is unavailable. Use Copy log.");
      const file = new File(Paths.cache, "floor-frame-ar-diagnostics.txt");
      file.write(capture("log_share"));
      await Sharing.shareAsync(file.uri, { mimeType: "text/plain", UTI: "public.plain-text", dialogTitle: "Share AR diagnostic log" });
    } catch (error) { Alert.alert("Could not share log", String(error)); }
    finally { setBusy(false); }
  }
  return <>
    <View style={s.actions}>
      <Action label="Mark sinking now" onPress={mark} />
      <Action label="Debug logs" onPress={show} />
    </View>
    <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={s.panel}>
        <Text style={s.title}>AR diagnostics</Text>
        <Text style={s.help}>{feedback}</Text>
        <Text style={s.help}>Keep your usual occlusion setting. Mark the moment it sinks, then copy or share the log.</Text>
        <View style={s.actions}>
          <Action label="Copy log" onPress={() => void copy()} disabled={busy} />
          <Action label="Share full log" onPress={() => void share()} disabled={busy} />
          <Action label="Refresh preview" onPress={() => setSnapshot(capture("log_preview_refreshed"))} />
          <Action label="Close" onPress={() => setOpen(false)} />
        </View>
        <Text style={s.help}>Latest 12,000 characters below. Copy includes up to 350,000 characters; Share includes the full buffered capture. Export before closing the app.</Text>
        <ScrollView style={s.preview}>
          <Text selectable style={s.code}>{snapshot.slice(-12_000)}</Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  </>;
}
function Action({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[s.button, disabled && s.disabled]}>
    <Text style={s.buttonText}>{label}</Text>
  </Pressable>;
}
const s = StyleSheet.create({
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { minHeight: 44, paddingHorizontal: 12, justifyContent: "center", borderRadius: 10, backgroundColor: "#214039" },
  buttonText: { color: "#a4ffe5", fontSize: 13, fontWeight: "600" },
  disabled: { opacity: 0.4 },
  panel: { flex: 1, backgroundColor: "#081317", paddingHorizontal: 16, gap: 12 },
  title: { color: "white", fontSize: 22, fontWeight: "600" },
  help: { color: "#b8b8bf", fontSize: 12 },
  preview: { flex: 1, backgroundColor: "#112126", padding: 10 },
  code: { color: "#c6eedf", fontSize: 10, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
});
