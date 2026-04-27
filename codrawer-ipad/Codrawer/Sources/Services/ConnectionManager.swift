import Foundation
import Combine

class ConnectionManager: ObservableObject {
    private var webSocketTask: URLSessionWebSocketTask?
    private let url: URL
    
    @Published var isConnected: Bool = false
    @Published var lastError: String?
    
    // Passthrough subject for incoming messages to be handled by the app
    let messageSubject = PassthroughSubject<InboundMessage, Never>()
    
    init(urlString: String = "ws://127.0.0.1:8577/ws/test") {
        self.url = URL(string: urlString)!
    }
    
    func connect() {
        let session = URLSession(configuration: .default)
        webSocketTask = session.webSocketTask(with: url)
        webSocketTask?.resume()
        
        isConnected = true
        receiveMessage()
        
        // Send Hello
        let hello = Hello(session: UUID().uuidString)
        send(hello)
    }
    
    func disconnect() {
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        isConnected = false
    }
    
    func send<T: Codable>(_ message: T) {
        guard let data = try? JSONEncoder().encode(message),
              let jsonString = String(data: data, encoding: .utf8) else {
            print("Failed to encode message")
            return
        }
        
        let message = URLSessionWebSocketTask.Message.string(jsonString)
        webSocketTask?.send(message) { error in
            if let error = error {
                DispatchQueue.main.async {
                    self.lastError = "Send error: \(error.localizedDescription)"
                }
            }
        }
    }
    
    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            guard let self = self else { return }
            
            switch result {
            case .failure(let error):
                DispatchQueue.main.async {
                    self.isConnected = false
                    self.lastError = "Receive error: \(error.localizedDescription)"
                }
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleJSON(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleJSON(text)
                    }
                @unknown default:
                    break
                }
                // Continue receiving
                self.receiveMessage()
            }
        }
    }
    
    private func handleJSON(_ json: String) {
        guard let data = json.data(using: .utf8) else { return }
        
        // Naive parsing to determine type - efficient enough for prototype
        // In a real app, use a discriminating decoder
        do {
            if let base = try? JSONDecoder().decode(BaseMessage.self, from: data) {
                switch base.t {
                case "stroke_begin":
                    if let msg = try? JSONDecoder().decode(StrokeBegin.self, from: data) {
                        DispatchQueue.main.async { self.messageSubject.send(.strokeBegin(msg)) }
                    }
                case "stroke_pts":
                    if let msg = try? JSONDecoder().decode(StrokePts.self, from: data) {
                        DispatchQueue.main.async { self.messageSubject.send(.strokePts(msg)) }
                    }
                case "stroke_end":
                    if let msg = try? JSONDecoder().decode(StrokeEnd.self, from: data) {
                        DispatchQueue.main.async { self.messageSubject.send(.strokeEnd(msg)) }
                    }
                case "ai_stroke_begin":
                    if let msg = try? JSONDecoder().decode(AIStrokeBegin.self, from: data) {
                        DispatchQueue.main.async { self.messageSubject.send(.aiStrokeBegin(msg)) }
                    }
                case "ai_stroke_pts":
                    if let msg = try? JSONDecoder().decode(AIStrokePts.self, from: data) {
                        DispatchQueue.main.async { self.messageSubject.send(.aiStrokePts(msg)) }
                    }
                case "ai_stroke_end":
                    if let msg = try? JSONDecoder().decode(AIStrokeEnd.self, from: data) {
                        DispatchQueue.main.async { self.messageSubject.send(.aiStrokeEnd(msg)) }
                    }
                case "cursor":
                    if let msg = try? JSONDecoder().decode(Cursor.self, from: data) {
                        DispatchQueue.main.async { self.messageSubject.send(.cursor(msg)) }
                    }
                default:
                    // print("Unknown message type: \(base.t)")
                    break
                }
            }
        }
    }
}
