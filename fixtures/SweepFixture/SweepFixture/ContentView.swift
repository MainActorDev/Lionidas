// swiftlint:disable all
// SweepFixture — deliberate AX-walk-blindness fixture for Crucible sweep Tier 1.
// Phase-switched via UserDefaults "sweepPhase":
//   record = "Fixture Card" button in the body (walk-VISIBLE — selector capture)
//   blind  = same-labeled control inside bar constructs (candidate walk-blind)
// The app prints nothing; the observable state is the label at the top
// ("PHASE: <phase>") plus the tapped-marker text ("TAPPED n×") so the probe
// and expect steps have real UI to verify against.

import SwiftUI

struct BarButtonView: View {
    let title: String
    let onTap: () -> Void
    var body: some View {
        Button(action: onTap) { Text(title) }
    }
}

struct ContentView: View {
    @AppStorage("sweepPhase") private var phase = "record"
    @State private var taps = 0

    var body: some View {
        let tap = { taps += 1 }
        VStack(spacing: 24) {
            Text("PHASE: \(phase)")
                .font(.headline)
                .accessibilityIdentifier("phase-label")
            Text("TAPPED \(taps)×")
                .font(.title2)
                .accessibilityIdentifier("tapped-label")
            switch phase {
            case "blind-toolbar":
                // candidate 1: SwiftUI ToolbarItem in navigation bar
                NavigationStack {
                    Text("toolbar variant")
                        .navigationTitle("Fixture")
                        .toolbar {
                            ToolbarItem(placement: .primaryAction) {
                                BarButtonView(title: "Fixture Card", onTap: tap)
                            }
                        }
                }
            case "blind-safearea":
                // candidate 2: safeAreaInset(edge: .bottom) bar
                Text("safeArea variant")
                    .safeAreaInset(edge: .bottom) {
                        HStack {
                            BarButtonView(title: " Fixture Card ", onTap: tap)
                            Spacer()
                        }
                        .padding()
                        .background(.bar)
                    }
            case "blind-overlay":
                // candidate 3: plain overlay bar
                Text("overlay variant")
                            .overlay(alignment: .bottom) {
                                HStack {
                                    BarButtonView(title: "Fixture Card", onTap: tap)
                                    Spacer()
                                }
                                .padding()
                                .background(.bar)
                            }
            case "blind-gesture":
                // candidate 4: gesture-only tap area — no Button semantics,
                // no label: the "container swallows taps" shape
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.green.opacity(0.2))
                    .frame(width: 300, height: 120)
                    .onTapGesture { taps += 1 }
            default:
                // record phase: the control in the body — walk-visible
                BarButtonView(title: "Fixture Card", onTap: tap)
                    .font(.title2)
                    .padding()
                    .background(Color.blue.opacity(0.15))
                    .cornerRadius(12)
            }
        }
        .padding()
    }
}

@main
struct SweepFixtureApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
