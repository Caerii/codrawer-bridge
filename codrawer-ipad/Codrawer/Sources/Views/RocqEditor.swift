import SwiftUI
import UIKit

struct RocqEditor: View {
    @Binding var text: String
    
    var body: some View {
        VStack(alignment: .leading) {
            Text("Rocq Prover")
                .font(.caption)
                .foregroundColor(.secondary)
                .padding(.leading)
            
            SyntaxTextEditor(text: $text)
                .background(Color(UIColor.secondarySystemBackground))
                .cornerRadius(8)
                .padding()
        }
    }
}

struct SyntaxTextEditor: UIViewRepresentable {
    @Binding var text: String

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.delegate = context.coordinator
        textView.font = UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        textView.autocapitalizationType = .none
        textView.backgroundColor = .clear
        textView.isScrollEnabled = true
        return textView
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        // Only update if content changed externally to avoid cursor resets
        if uiView.text != text {
            uiView.text = text
            context.coordinator.highlight(textView: uiView)
        }
    }

    class Coordinator: NSObject, UITextViewDelegate {
        var parent: SyntaxTextEditor

        init(_ parent: SyntaxTextEditor) {
            self.parent = parent
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            highlight(textView: textView)
        }
        
        func highlight(textView: UITextView) {
            let text = textView.text ?? ""
            let attributedString = NSMutableAttributedString(string: text)
            let range = NSRange(location: 0, length: text.utf16.count)
            
            // Default attributes
            attributedString.addAttribute(.font, value: UIFont.monospacedSystemFont(ofSize: 14, weight: .regular), range: range)
            attributedString.addAttribute(.foregroundColor, value: UIColor.label, range: range)
            
            // Keywords
            let keywords = ["Theorem", "Proof", "Qed", "intros", "induction", "reflexivity", "simpl", "rewrite", "forall", "match", "with", "end", "Definition", "Fixpoint"]
            let keywordColor = UIColor.systemPurple
            
            for word in keywords {
                // Naive find
                var searchRange = range
                while true {
                    let foundRange = (text as NSString).range(of: "\\b\(word)\\b", options: .regularExpression, range: searchRange)
                    if foundRange.location == NSNotFound { break }
                    
                    attributedString.addAttribute(.foregroundColor, value: keywordColor, range: foundRange)
                    attributedString.addAttribute(.font, value: UIFont.monospacedSystemFont(ofSize: 14, weight: .bold), range: foundRange)
                    
                    let newLocation = foundRange.location + foundRange.length
                    searchRange = NSRange(location: newLocation, length: range.length - newLocation)
                }
            }
            
            // Comments (* ... *)
            // Regex for comments is harder due to nesting, just doing simplistic (* ... *)
            // This is a naive implementation for demo purposes.
            
            // Apply changes preserving cursor
            let selectedRange = textView.selectedRange
            textView.attributedText = attributedString
            textView.selectedRange = selectedRange
        }
    }
}

struct GoalView: View {
    var body: some View {
        VStack(alignment: .leading) {
            HStack {
                Text("Goals")
                    .font(.headline)
                Spacer()
                Text("1 subgoal")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding([.top, .horizontal])
            
            List {
                Section(header: Text("Hypotheses")) {
                    Text("n : nat")
                        .font(.system(.body, design: .monospaced))
                    Text("IHn : n + 0 = n")
                        .font(.system(.body, design: .monospaced))
                }
                
                Section(header: Text("Goal")) {
                    Text("S n + 0 = S n")
                        .font(.system(.body, design: .monospaced))
                        .bold()
                }
            }
            .listStyle(.insetGrouped)
        }
        .background(Color(UIColor.systemBackground))
    }
}