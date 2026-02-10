import SwiftUI
import PencilKit

struct CanvasView: UIViewRepresentable {
    @Binding var canvasView: PKCanvasView
    @Binding var toolPicker: PKToolPicker
    @ObservedObject var connectionManager: ConnectionManager
    
    // State to track strokes to avoid re-sending existing ones
    // In a real app, use a more robust ID system
    class Coordinator: NSObject, PKCanvasViewDelegate {
        var parent: CanvasView
        var lastDrawing: PKDrawing?
        
        init(_ parent: CanvasView) {
            self.parent = parent
        }
        
        func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
            // Detect new strokes
            // This is naive: assuming the new stroke is the last one in the strokes array.
            // PKDrawing.strokes is just an array.
            let newDrawing = canvasView.drawing
            let oldStrokes = lastDrawing?.strokes ?? []
            let newStrokes = newDrawing.strokes
            
            if newStrokes.count > oldStrokes.count {
                // A new stroke was added
                let stroke = newStrokes.last!
                sendStroke(stroke)
            }
            
            lastDrawing = newDrawing
        }
        
        func sendStroke(_ stroke: PKStroke) {
            let id = UUID().uuidString
            let now = Int(Date().timeIntervalSince1970 * 1000)
            
            // 1. Send Begin
            let begin = StrokeBegin(id: id, color: stroke.ink.color.description, ts: now)
            parent.connectionManager.send(begin)
            
            // 2. Send Points (Batch)
            let path = stroke.path
            var points: [Point4] = []
            
            // Resample or just take the points
            // PKStrokePath points are interpolated. We iterate the path.
            for point in path {
                let p = point.location
                // Normalize to [0,1] based on canvas bounds?
                // For now, assuming infinite canvas or fixed size.
                // Let's assume a fixed virtual coordinate space or just send raw if server handles it.
                // The protocol says [x,y] in [0,1].
                // We need the canvas size.
                let bounds = parent.canvasView.bounds
                let x = Double(p.x / bounds.width)
                let y = Double(p.y / bounds.height)
                // Force, Timestamp?
                let force = 0.5 // Default if not available easily without iterating interpolated points
                // PKStrokePoint has force, but `path` iteration gives points.
                
                points.append([x, y, force, Double(now)])
            }
            
            let ptsMsg = StrokePts(id: id, pts: points)
            parent.connectionManager.send(ptsMsg)
            
            // 3. Send End
            let end = StrokeEnd(id: id, ts: now)
            parent.connectionManager.send(end)
        }
    }
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    func makeUIView(context: Context) -> PKCanvasView {
        canvasView.delegate = context.coordinator
        canvasView.drawingPolicy = .anyInput
        canvasView.backgroundColor = .clear
        canvasView.isOpaque = false
        
        // Setup ToolPicker
        toolPicker.setVisible(true, forFirstResponder: canvasView)
        toolPicker.addObserver(canvasView)
        canvasView.becomeFirstResponder()
        
        return canvasView
    }
    
    func updateUIView(_ uiView: PKCanvasView, context: Context) {
        // Handle incoming external changes if necessary
    }
}
