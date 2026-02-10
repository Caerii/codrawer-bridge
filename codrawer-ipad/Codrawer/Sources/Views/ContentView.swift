import SwiftUI
import PencilKit
import Combine

struct ContentView: View {
    @StateObject var connectionManager = ConnectionManager()
    
    // Editor State
    @State private var code: String = "Theorem add_0_r : forall n, n + 0 = n.\nProof.\n  intros.\n  induction n.\n  - reflexivity.\n  - simpl. rewrite IHn. reflexivity.\nQed."
    
    // Drawing State
    @State private var canvasView = PKCanvasView()
    @State private var toolPicker = PKToolPicker()
    @State private var aiStrokes: [String: [Point3]] = [:] // ID -> Points
    @State private var finishedAIStrokes: [String: [Point3]] = [:]
    
    // AI Interaction
    @State private var promptText: String = ""
    
    var body: some View {
        NavigationSplitView {
            // Sidebar: File Browser
            List {
                Label("Proof.v", systemImage: "doc.text")
                Label("Drawing.v", systemImage: "doc.text")
            }
            .navigationTitle("Files")
        } content: {
            // Middle: Editor
            VStack(spacing: 0) {
                RocqEditor(text: $code)
                Divider()
                GoalView()
            }
        } detail: {
            // Right: Canvas & Visualization
            ZStack(alignment: .bottom) {
                // 1. The Real Canvas
                CanvasView(canvasView: $canvasView, toolPicker: $toolPicker, connectionManager: connectionManager)
                
                // 2. The AI Overlay
                GeometryReader { geo in
                    Canvas { context, size in
                        // Render ongoing strokes
                        for (_, pts) in aiStrokes {
                            drawPoints(context: context, pts: pts, size: size, color: .blue)
                        }
                        // Render finished strokes (if we don't bake them)
                        for (_, pts) in finishedAIStrokes {
                            drawPoints(context: context, pts: pts, size: size, color: .purple)
                        }
                    }
                    .allowsHitTesting(false)
                }
                
                // 3. Prompt Bar
                HStack {
                    TextField("Ask AI to draw...", text: $promptText)
                        .textFieldStyle(.roundedBorder)
                        .padding(.horizontal)
                    
                    Button(action: sendPrompt) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                    }
                    .disabled(promptText.isEmpty)
                }
                .padding()
                .background(.ultraThinMaterial)
                .padding(.bottom)
            }
            .navigationTitle("Canvas")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: {
                        if connectionManager.isConnected {
                            connectionManager.disconnect()
                        } else {
                            connectionManager.connect()
                        }
                    }) {
                        Image(systemName: connectionManager.isConnected ? "network" : "network.slash")
                            .foregroundColor(connectionManager.isConnected ? .green : .red)
                    }
                }
            }
        }
        .onReceive(connectionManager.messageSubject) { msg in
            handleMessage(msg)
        }
        .onAppear {
            connectionManager.connect()
        }
    }
    
    func sendPrompt() {
        guard !promptText.isEmpty else { return }
        let prompt = Prompt(text: promptText, ts: Int(Date().timeIntervalSince1970 * 1000))
        connectionManager.send(prompt)
        promptText = ""
    }
    
    func drawPoints(context: GraphicsContext, pts: [Point3], size: CGSize, color: Color) {
        guard pts.count > 1 else { return }
        var path = Path()
        
        let width = size.width
        let height = size.height
        
        let start = pts[0]
        path.move(to: CGPoint(x: start[0] * width, y: start[1] * height))
        
        for i in 1..<pts.count {
            let p = pts[i]
            path.addLine(to: CGPoint(x: p[0] * width, y: p[1] * height))
        }
        
        context.stroke(path, with: .color(color), lineWidth: 2)
    }
    
    func handleMessage(_ msg: InboundMessage) {
        switch msg {
        case .aiStrokeBegin(let m):
            aiStrokes[m.id] = []
        case .aiStrokePts(let m):
            if var pts = aiStrokes[m.id] {
                pts.append(contentsOf: m.pts)
                aiStrokes[m.id] = pts
            }
        case .aiStrokeEnd(let m):
            if let pts = aiStrokes[m.id] {
                finishedAIStrokes[m.id] = pts
                aiStrokes.removeValue(forKey: m.id)
            }
        default:
            break
        }
    }
}