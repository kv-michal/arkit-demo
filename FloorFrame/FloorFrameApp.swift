import SwiftUI
import RealityKit

@main
struct FloorFrameApp: App {
    var body: some SwiftUI.Scene { WindowGroup { ContentView() } }
}

struct CameraView: UIViewRepresentable {
    let model: PlacementModel
    func makeUIView(context: Context) -> ARView { model.view }
    func updateUIView(_ uiView: ARView, context: Context) {}
}

struct ContentView: View {
    @StateObject private var model = PlacementModel()
    @Environment(\.scenePhase) private var phase
    @State private var diagnosticsPresented = false
    @State private var sinkingMarked = false
    private var primaryTitle: String {
        if model.locked { return "Reposition" }
        if model.phase.isCalibrating || model.mode == .baseline { return "Anchor rectangle" }
        return model.mode == .surveyed ? "Anchor to survey" : "Start calibration"
    }
    private var primaryEnabled: Bool {
        model.locked || model.phase == .readyToCommit || (model.phase == .searching && model.ready)
    }
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                CameraView(model: model).ignoresSafeArea()
                LinearGradient(colors: [.black.opacity(0.65), .clear, .black.opacity(0.65)], startPoint: .top, endPoint: .bottom).ignoresSafeArea().allowsHitTesting(false)
                VStack(spacing: 16) {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("FLOOR FRAME").font(.system(.headline, design: .rounded)).tracking(2)
                            Text(model.locked ? "FIXED IN YOUR SPACE" : "SURFACE PREVIEW").font(.caption2).tracking(1.5).foregroundStyle(.white.opacity(0.65))
                        }
                        Spacer()
                        Button(action: model.reset) { Image(systemName: "arrow.counterclockwise").padding(13).background(.ultraThinMaterial, in: Circle()) }
                            .accessibilityLabel("Reset scan").accessibilityIdentifier("reset")
                    }
                    Color.clear
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .overlay {
                            Image(systemName: model.locked ? "lock.fill" : "plus")
                                .font(.system(size: 25, weight: .light))
                                .foregroundStyle(model.ready || model.locked ? Color.mint : .white)
                                .shadow(radius: 4).accessibilityHidden(true)
                        }
                        .background {
                            GeometryReader { target in
                                Color.clear.preference(key: AimPointPreference.self, value: target.frame(in: .global))
                            }
                        }
                        .allowsHitTesting(false)
                    VStack(spacing: 14) {
                        HStack {
                            Button("Mark sinking now") { model.markSinking(); sinkingMarked = true }
                                .accessibilityIdentifier("markSinking")
                            Button("Debug logs") { diagnosticsPresented = true }
                                .accessibilityIdentifier("debugLogs")
                        }.buttonStyle(.bordered).tint(.mint).controlSize(.regular)

                        VStack(spacing: 4) {
                            Label(model.message, systemImage: model.locked ? "checkmark.circle.fill" : (model.ready ? "scope" : "viewfinder"))
                                .font(.subheadline.weight(.semibold)).multilineTextAlignment(.center)
                            Text(model.detail).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            if !model.quality.isEmpty {
                                Text(model.quality).font(.caption).foregroundStyle(.mint).multilineTextAlignment(.center)
                            }
                            Text(model.budget).font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
                                .accessibilityIdentifier("accuracyBudget")
                        }.accessibilityIdentifier("placementStatus")
                        Picker("Placement mode", selection: Binding(get: { model.mode }, set: { model.setMode($0) })) {
                            ForEach(PlacementMode.allCases) { mode in
                                Text(mode.label).tag(mode)
                            }
                        }.pickerStyle(.segmented).accessibilityIdentifier("modePicker")
                            .disabled(model.phase != .searching || model.busy)
                        Picker("Rectangle width", selection: $model.large) {
                            Text("20 cm wide").tag(false)
                            Text("3 m wide").tag(true)
                        }.pickerStyle(.segmented).accessibilityIdentifier("widthPicker")
                            .onChange(of: model.large) { _, _ in model.rebuildBlock() }
                        Stepper("Rectangles: \(model.rectangleCount)", value: $model.rectangleCount, in: 1...51)
                            .font(.subheadline).accessibilityIdentifier("rectangleCountStepper")
                            .onChange(of: model.rectangleCount) { _, _ in model.rebuildBlock() }
                        Toggle("Follow anchor updates", isOn: $model.followAnchorUpdates)
                            .font(.subheadline).tint(.mint)
                            .accessibilityIdentifier("followAnchorToggle")
                            .onChange(of: model.followAnchorUpdates) { _, _ in model.changeAnchorFollowing() }
                        Toggle("Occlusion", isOn: $model.occlusion)
                            .font(.subheadline).tint(.mint)
                            .disabled(!model.supportsLiDAR)
                            .accessibilityIdentifier("occlusionToggle")
                            .onChange(of: model.occlusion) { _, _ in model.changeOcclusion() }
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("LiDAR mesh").font(.subheadline.weight(.medium))
                                Text(model.supportsLiDAR ? (model.lidar ? "Depth-assisted surfaces" : (model.occlusion ? "Mesh active for occlusion" : "Standard ARKit surfaces")) : "Unavailable · using standard ARKit").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Toggle("LiDAR mesh", isOn: $model.lidar).labelsHidden().tint(.mint)
                                .disabled(!model.supportsLiDAR || model.locked || model.cameraDenied)
                                .accessibilityIdentifier("lidarToggle")
                                .onChange(of: model.lidar) { _, _ in model.changeMode() }
                        }
                        Text(model.dimensions).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        if model.cameraDenied {
                            Button("Open Camera Settings") {
                                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                            }.buttonStyle(.borderedProminent).tint(.mint)
                        } else {
                            Button(action: model.primaryAction) {
                                Label(primaryTitle, systemImage: model.locked ? "move.3d" : (model.phase.isCalibrating || model.mode == .baseline || model.mode == .surveyed ? "pin.fill" : "ruler"))
                                    .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 9)
                            }.buttonStyle(.borderedProminent).tint(.mint).foregroundStyle(.black)
                                .disabled(!primaryEnabled).accessibilityIdentifier("anchorButton")
                            if model.phase.isCalibrating {
                                Button("Cancel calibration") { model.reposition("Calibration cancelled") }
                                    .font(.subheadline.weight(.medium)).foregroundStyle(Color(red: 1, green: 0.62, blue: 0.62))
                                    .accessibilityIdentifier("cancelCalibration")
                            }
                        }
                    }
                    .padding(20).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 26))
                    .frame(maxWidth: 440)
                }
                .padding(.horizontal, 20).padding(.vertical, geometry.size.height < 500 ? 4 : 12)
            }
        }
        .onPreferenceChange(AimPointPreference.self) { frame in
            if frame.width > 0 && frame.height > 0 { model.setAimRect(frame) }
        }
        .sheet(isPresented: $diagnosticsPresented) { DiagnosticsPanel(model: model) }
        .alert("Sinking marked", isPresented: $sinkingMarked) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Timestamp and current placement saved. Use Debug logs to copy or share the capture.")
        }
        .preferredColorScheme(.dark)
        .onAppear { model.start() }
        .onChange(of: phase) { _, newPhase in
            if newPhase == .active { model.start() }
            else { model.pause() }
        }
    }
}

private struct AimPointPreference: PreferenceKey {
    static var defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}
