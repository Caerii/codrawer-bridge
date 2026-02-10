import Foundation

// MARK: - Protocol Constants
typealias Point4 = [Double] // [x, y, p, t]
typealias Point3 = [Double] // [x, y, p]

// MARK: - Message Types

struct BaseMessage: Codable {
    let t: String
}

struct Hello: Codable {
    let t = "hello"
    let session: String
}

struct StrokeBegin: Codable {
    let t = "stroke_begin"
    let id: String
    var layer: String = "user" // "user" or "ai"
    var brush: String = "pen"
    var color: String?
    let ts: Int // ms timestamp
}

struct StrokePts: Codable {
    let t = "stroke_pts"
    let id: String
    let pts: [Point4]
}

struct StrokeEnd: Codable {
    let t = "stroke_end"
    let id: String
    let ts: Int
}

struct Cursor: Codable {
    let t = "cursor"
    let x: Double
    let y: Double
    let ts: Int
    var who: String?
}

struct Prompt: Codable {
    let t = "prompt"
    let text: String
    var mode: String = "draw" // "draw" or "handwriting"
    var x: Double?
    var y: Double?
    var ts: Int?
}

// MARK: - AI Messages (Inbound to Client usually, but definitions are shared)

struct AIStrokeBegin: Codable {
    let t = "ai_stroke_begin"
    let id: String
    let layer: String = "ai"
    let brush: String = "ghost"
}

struct AIStrokePts: Codable {
    let t = "ai_stroke_pts"
    let id: String
    let pts: [Point3]
}

struct AIStrokeEnd: Codable {
    let t = "ai_stroke_end"
    let id: String
}

struct AIIntent: Codable {
    let t = "ai_intent"
    let plan: String
    var mode: String = "auto"
    var prompt_text: String?
    var anchor_xy: [Double]?
}

struct AISay: Codable {
    let t = "ai_say"
    let text: String
}

// MARK: - Message Wrapper enum for decoding
enum InboundMessage {
    case strokeBegin(StrokeBegin)
    case strokePts(StrokePts)
    case strokeEnd(StrokeEnd)
    case aiStrokeBegin(AIStrokeBegin)
    case aiStrokePts(AIStrokePts)
    case aiStrokeEnd(AIStrokeEnd)
    case cursor(Cursor)
    case unknown(String)
}
