import WidgetKit
import SwiftUI

// MARK: - Backend model

// One row returned by the Supabase RPC latest_usage().
struct UsageRow: Decodable {
    let captured_at: String
    let block_start: String?
    let block_end: String?
    let total_tokens: Int
    let cost_usd: Double
    let is_active: Bool
}

enum UsageAPI {
    // Postgres returns microseconds (e.g. 2026-11-16T12:21:09.123456+00:00); trim to milliseconds.
    static func parseDate(_ string: String?) -> Date? {
        guard var s = string else { return nil }
        if let range = s.range(of: #"\.\d+"#, options: .regularExpression) {
            let fraction = String(s[range].prefix(4)) // "." + 3 digits
            s.replaceSubrange(range, with: fraction)
        }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFraction.date(from: s) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: s)
    }

    static func fetchLatest() async throws -> UsageRow? {
        guard let url = URL(string: "\(Config.supabaseURL)/rest/v1/rpc/latest_usage") else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue(Config.publishableKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode([UsageRow].self, from: data).first
    }
}

// MARK: - Timeline

enum DataState: Equatable {
    case fresh
    case stale   // snapshot is older than Config.staleAfter
    case empty   // backend has no data yet
    case error(String)   // request failed, with a short description for debugging
}

struct UsageEntry: TimelineEntry {
    let date: Date
    let costUSD: Double
    let totalTokens: Int
    let fraction: Double      // 0...1, share of the 5h window that has elapsed (placeholder until real plan %)
    let capturedAt: Date?
    let state: DataState
}

extension UsageEntry {
    static let placeholder = UsageEntry(date: .now, costUSD: 3.10, totalTokens: 518_880,
                                        fraction: 0.42, capturedAt: .now, state: .fresh)
}

struct UsageProvider: TimelineProvider {
    func placeholder(in context: Context) -> UsageEntry { .placeholder }

    func getSnapshot(in context: Context, completion: @escaping (UsageEntry) -> Void) {
        if context.isPreview { completion(.placeholder); return }
        Task { completion(await load()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<UsageEntry>) -> Void) {
        Task {
            let entry = await load()
            let next = Date().addingTimeInterval(Config.refreshInterval)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }

    private static func describe(_ error: Error) -> String {
        if let decoding = error as? DecodingError { return "decode: \(decoding)".prefix(80).description }
        let ns = error as NSError
        return "\(ns.domain) \(ns.code)"
    }

    private func load() async -> UsageEntry {
        do {
            guard let row = try await UsageAPI.fetchLatest() else {
                return UsageEntry(date: .now, costUSD: 0, totalTokens: 0, fraction: 0, capturedAt: nil, state: .empty)
            }
            let captured = UsageAPI.parseDate(row.captured_at)
            let isStale = captured.map { Date().timeIntervalSince($0) > Config.staleAfter } ?? true

            var fraction = 0.0
            if row.is_active, let start = UsageAPI.parseDate(row.block_start) {
                fraction = min(max(Date().timeIntervalSince(start) / Config.windowLength, 0), 1)
            }
            return UsageEntry(date: .now, costUSD: row.cost_usd, totalTokens: row.total_tokens,
                              fraction: fraction, capturedAt: captured, state: isStale ? .stale : .fresh)
        } catch {
            return UsageEntry(date: .now, costUSD: 0, totalTokens: 0, fraction: 0, capturedAt: nil,
                              state: .error(Self.describe(error)))
        }
    }
}

// MARK: - Views

private func shortTokens(_ n: Int) -> String {
    n >= 1_000_000 ? String(format: "%.1fM", Double(n) / 1_000_000)
        : n >= 1_000 ? "\(n / 1_000)k" : "\(n)"
}

private func money(_ value: Double, decimals: Int) -> String {
    "$" + String(format: "%.\(decimals)f", value)
}

struct UsageRing: View {
    let fraction: Double
    let label: String
    var body: some View {
        ZStack {
            Circle().stroke(.secondary.opacity(0.3), lineWidth: 6)
            Circle()
                .trim(from: 0, to: fraction)
                .stroke(.primary, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text(label).font(.system(size: 13, weight: .semibold)).minimumScaleFactor(0.6)
        }
    }
}

struct StatusLine: View {
    let entry: UsageEntry
    var body: some View {
        switch entry.state {
        case .fresh, .stale:
            if let captured = entry.capturedAt {
                HStack(spacing: 2) {
                    if entry.state == .stale { Image(systemName: "exclamationmark.triangle") }
                    Text(captured, style: .relative)
                }
            }
        case .empty: Text("no data yet")
        case .error(let message): Text(message)
        }
    }
}

struct UsageWidgetView: View {
    @Environment(\.widgetFamily) var family
    let entry: UsageEntry

    private var hasData: Bool { entry.state == .fresh || entry.state == .stale }
    private var costLabel: String { hasData ? money(entry.costUSD, decimals: 2) : "--" }

    var body: some View {
        switch family {
        case .accessoryCircular:
            UsageRing(fraction: entry.fraction, label: hasData ? money(entry.costUSD, decimals: 1) : "--")
                .padding(2)
        case .accessoryRectangular:
            HStack(spacing: 8) {
                UsageRing(fraction: entry.fraction, label: "\(Int(entry.fraction * 100))%")
                    .frame(width: 44, height: 44)
                VStack(alignment: .leading) {
                    Text("Claude 5h").font(.caption2)
                    Text(costLabel).font(.headline)
                    StatusLine(entry: entry).font(.caption2)
                }
            }
        default:
            VStack(spacing: 6) {
                UsageRing(fraction: entry.fraction, label: "\(Int(entry.fraction * 100))%")
                    .frame(width: 70, height: 70)
                Text(costLabel).font(.headline)
                Text(hasData ? shortTokens(entry.totalTokens) + " tokens" : " ")
                    .font(.caption2).foregroundStyle(.secondary)
                StatusLine(entry: entry).font(.caption2).foregroundStyle(.secondary).lineLimit(3).multilineTextAlignment(.center)
            }
        }
    }
}

struct UsageWidget: Widget {
    let kind = "UsageWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: UsageProvider()) { entry in
            UsageWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Claude usage")
        .description("Claude usage in the active 5h window.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .systemSmall])
    }
}

#Preview(as: .systemSmall) {
    UsageWidget()
} timeline: {
    UsageEntry.placeholder
}
