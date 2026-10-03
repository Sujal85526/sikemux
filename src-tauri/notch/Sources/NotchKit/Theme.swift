import AppKit
import CoreText
import SwiftUI

/// The app's colours and type, as `src/styles/base.css` defines them.
enum Theme {
    static let ink = Color(hex: "#e7e5ef")
    static let inkDim = Color(hex: "#8b8898")
    static let inkFaint = Color(hex: "#736f80")
    static let accent = Color(hex: "#a277ff")
    static let accentSoft = Color(hex: "#a277ff").opacity(0.16)
    static let accentLine = Color(hex: "#a277ff").opacity(0.42)
    static let onAccent = Color(hex: "#100e16")
    static let live = Color(hex: "#61ffca")
    static let warn = Color(hex: "#ffca85")
    static let command = Color(hex: "#ff6ac1")
    static let danger = Color(hex: "#ff6767")
    static let raised = Color.white.opacity(0.06)
    static let hover = Color.white.opacity(0.07)
    static let hairline = Color.white.opacity(0.09)

    static let yolo = LinearGradient(colors: [accent, command, danger, warn, live, accent], startPoint: .leading, endPoint: .trailing)

    private static var registered = false

    /// Loads Figtree from `directory`; without it the island falls back to the system face.
    static func registerFonts(in directory: String?) {
        guard !registered, let directory else { return }
        registered = true
        let names = ["Figtree_400Regular.ttf", "Figtree_500Medium.ttf", "Figtree_600SemiBold.ttf"]
        for name in names {
            let url = URL(fileURLWithPath: directory).appendingPathComponent(name)
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        let name: String
        switch weight {
        case .semibold, .bold, .heavy, .black: name = "Figtree-SemiBold"
        case .medium: name = "Figtree-Medium"
        default: name = "Figtree-Regular"
        }
        if NSFont(name: name, size: size) != nil {
            return .custom(name, fixedSize: size)
        }
        return .system(size: size, weight: weight)
    }

    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

extension Color {
    init(hex: String) {
        var text = hex.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("#") { text.removeFirst() }
        if text.count == 3 { text = text.map { "\($0)\($0)" }.joined() }
        let value = UInt64(text, radix: 16) ?? 0
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xff) / 255,
            green: Double((value >> 8) & 0xff) / 255,
            blue: Double(value & 0xff) / 255,
            opacity: 1
        )
    }
}
