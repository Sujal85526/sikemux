import FluidAudio
import Foundation

actor Dictation {
    private static let minimumSeconds = 0.3

    private var asr: AsrManager?
    private var spotter: CtcKeywordSpotter?
    private var ctcDirectory: URL?
    private var tokenizer: CtcTokenizer?
    private var boosting: (terms: [String], context: CustomVocabularyContext, rescorer: VocabularyRescorer)?
    private var recorder: Recorder?
    private var vocabulary: [String] = []

    @discardableResult
    func prepare(modelsDir: String) async -> Bool {
        if asr != nil {
            Output.send(["type": "ready"])
            return true
        }
        let root = URL(fileURLWithPath: modelsDir, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let asrDirectory = root.appendingPathComponent(
                AsrModels.defaultCacheDirectory(for: .v3).lastPathComponent, isDirectory: true)
            let models = try await AsrModels.downloadAndLoad(
                to: asrDirectory, version: .v3,
                progressHandler: { progress in
                    switch progress.phase {
                    case .compiling:
                        Output.progress(stage: "compile", fraction: progress.fractionCompleted)
                    case .listing, .downloading:
                        Output.progress(stage: "download", fraction: progress.fractionCompleted)
                    }
                })
            let manager = AsrManager()
            try await manager.loadModels(models)

            Output.progress(stage: "vocabulary", fraction: 0)
            let ctcDirectory = root.appendingPathComponent(
                CtcModels.defaultCacheDirectory().lastPathComponent, isDirectory: true)
            let ctcModels = try await CtcModels.downloadAndLoad(to: ctcDirectory)
            let tokenizer = try await CtcTokenizer.load(from: ctcDirectory)
            Output.progress(stage: "vocabulary", fraction: 1)

            self.asr = manager
            self.spotter = CtcKeywordSpotter(models: ctcModels, blankId: ctcModels.vocabulary.count)
            self.ctcDirectory = ctcDirectory
            self.tokenizer = tokenizer
            Output.send(["type": "ready"])
            return true
        } catch {
            Output.failure("models", error.localizedDescription)
            return false
        }
    }

    func start(vocabulary: [String]) async {
        guard asr != nil else {
            Output.failure("models", "The speech model is not loaded yet.")
            return
        }
        if let recorder {
            _ = recorder.stop()
            self.recorder = nil
        }
        do {
            try await Recorder.ensurePermission()
            let recorder = Recorder()
            try recorder.start()
            self.recorder = recorder
            self.vocabulary = vocabulary
            Output.send(["type": "listening"])
        } catch RecorderError.microphoneDenied {
            Output.failure("microphone", RecorderError.microphoneDenied.localizedDescription)
        } catch {
            Output.failure("audio", error.localizedDescription)
        }
    }

    func cancel() {
        if let recorder {
            _ = recorder.stop()
            self.recorder = nil
        }
        Output.send(["type": "cancelled"])
    }

    func stop() async {
        guard let recorder, asr != nil else {
            Output.send(["type": "transcript", "text": ""])
            return
        }
        self.recorder = nil
        let captured = recorder.stop()
        guard Double(captured.samples.count) / captured.sampleRate >= Self.minimumSeconds else {
            Output.send(["type": "transcript", "text": ""])
            return
        }
        do {
            let text = try await transcribe(captured.samples, sampleRate: captured.sampleRate)
            Output.send(["type": "transcript", "text": text])
        } catch {
            Output.failure("transcribe", error.localizedDescription)
        }
    }

    func transcribe(file: URL, vocabulary: [String]) async throws -> String {
        guard asr != nil else { throw ASRError.notInitialized }
        self.vocabulary = vocabulary
        return try await transcribe(AudioConverter().resampleAudioFile(file), sampleRate: 16_000)
    }

    private func transcribe(_ captured: [Float], sampleRate: Double) async throws -> String {
        guard let asr else { throw ASRError.notInitialized }
        let samples =
            sampleRate == 16_000 ? captured : try AudioConverter().resample(captured, from: sampleRate)
        var decoderState = try TdtDecoderState()
        let result = try await asr.transcribe(samples, decoderState: &decoderState)
        let text = await boosted(result, samples: samples)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func boosted(_ result: ASRResult, samples: [Float]) async -> String {
        guard !vocabulary.isEmpty, let spotter,
            let timings = result.tokenTimings, !timings.isEmpty
        else { return result.text }
        do {
            guard let boosting = try await boosting(for: vocabulary, spotter: spotter) else {
                return result.text
            }
            let spotted = try await spotter.spotKeywordsWithLogProbs(
                audioSamples: samples, customVocabulary: boosting.context, minScore: nil)
            guard !spotted.logProbs.isEmpty else { return result.text }
            let tuning = ContextBiasingConstants.rescorerConfig(forVocabSize: boosting.context.terms.count)
            let output = boosting.rescorer.ctcTokenRescore(
                transcript: result.text,
                tokenTimings: timings,
                logProbs: spotted.logProbs,
                frameDuration: spotted.frameDuration,
                cbw: tuning.cbw,
                minSimilarity: tuning.minSimilarity
            )
            return output.wasModified ? output.text : result.text
        } catch {
            return result.text
        }
    }

    private func boosting(
        for terms: [String], spotter: CtcKeywordSpotter
    ) async throws -> (context: CustomVocabularyContext, rescorer: VocabularyRescorer)? {
        if let boosting, boosting.terms == terms { return (boosting.context, boosting.rescorer) }
        guard let tokenizer, let ctcDirectory else { return nil }
        let context = CustomVocabularyContext(
            terms: terms.compactMap { term in
                let ids = tokenizer.encode(term)
                return ids.isEmpty ? nil : CustomVocabularyTerm(text: term, ctcTokenIds: ids)
            })
        guard !context.terms.isEmpty else { return nil }
        let rescorer = try await VocabularyRescorer.create(
            spotter: spotter, vocabulary: context, ctcModelDirectory: ctcDirectory)
        boosting = (terms, context, rescorer)
        return (context, rescorer)
    }
}
