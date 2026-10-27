import SwiftUI

struct DiagnosticsPanel: View {
    let model: PlacementModel
    @Environment(\.dismiss) private var dismiss
    @State private var preview = ""
    @State private var feedback = "Recording automatically while AR is active"
    @State private var shareURL: URL?
    @State private var sharePresented = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text(feedback).font(.caption).accessibilityIdentifier("diagnosticsFeedback")
                Text("Keep your usual occlusion setting. Mark the moment it sinks, then copy or share the log.").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Copy log") {
                        let result = model.exportDiagnostics("log_copy", maxBytes: 350_000)
                        UIPasteboard.general.string = result.text
                        feedback = result.truncated ? "Recent log copied. Use Share full log for the full capture." : "Full log copied"
                    }.accessibilityIdentifier("copyLog")
                    Button("Share full log") {
                        do {
                            let url = FileManager.default.temporaryDirectory.appendingPathComponent("floor-frame-native-ar-diagnostics.txt")
                            try model.exportDiagnostics("log_share").text.write(to: url, atomically: true, encoding: .utf8)
                            shareURL = url; sharePresented = true
                        } catch { errorMessage = error.localizedDescription }
                    }.accessibilityIdentifier("shareLog")
                }.buttonStyle(.bordered).controlSize(.large)
                Button("Refresh preview") { refresh("log_preview_refreshed") }
                    .buttonStyle(.bordered).accessibilityIdentifier("refreshLog")
                Text("Latest 12,000 characters below. Copy includes up to 350,000 bytes; Share includes the full buffered capture. Export before closing the app.").font(.caption).foregroundStyle(.secondary)
                ScrollView {
                    Text(preview).font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(10)
                }.background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
            }.padding().navigationTitle("AR diagnostics").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Close") { dismiss() } } }
        }
        .onAppear { refresh("log_opened") }
        .sheet(isPresented: $sharePresented) { if let shareURL { DiagnosticShareSheet(url: shareURL) } }
        .alert("Could not share log", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("OK") { errorMessage = nil }
        } message: { Text(errorMessage ?? "") }
    }

    private func refresh(_ event: String) { preview = String(model.exportDiagnostics(event).text.suffix(12_000)) }
}

private struct DiagnosticShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
