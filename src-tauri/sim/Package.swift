// swift-tools-version:6.0
import PackageDescription

// idb's libraries mix Objective-C and Swift, which SwiftPM cannot build, so
// scripts/build-sim-helper.mjs builds them with xcodebuild into this directory first.
let idbProducts = Context.packageDirectory + "/.build/idb/Build/Products/Release"
let privateHeaders = Context.packageDirectory + "/idb/PrivateHeaders"

let package = Package(
    name: "sikemux-sim",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "sikemux-sim", targets: ["SikemuxSim"])
    ],
    targets: [
        .target(name: "SikemuxSimKit", path: "Sources/SikemuxSimKit"),
        .testTarget(name: "SikemuxSimKitTests", dependencies: ["SikemuxSimKit"], path: "Tests/SikemuxSimKitTests"),
        .executableTarget(
            name: "SikemuxSim",
            dependencies: ["SikemuxSimKit"],
            path: "Sources/SikemuxSim",
            swiftSettings: [
                .unsafeFlags(["-I", idbProducts, "-F", idbProducts, "-Xcc", "-isystem", "-Xcc", privateHeaders])
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-L", idbProducts, "-F", idbProducts,
                    // FBControlCore's Objective-C categories are only kept when the whole library is loaded.
                    "-Xlinker", "-force_load", "-Xlinker", idbProducts + "/FBControlCore.framework/FBControlCore",
                    "-Xlinker", "-ObjC",
                    "-lFBSimulatorControl", "-lSimulatorIPC", "-lSimulatorFrameworkBridgeProtocol", "-lCompanionUtilities",
                    "-Xlinker", "-weak_library", "-Xlinker", privateHeaders + "/CoreSimulator/CoreSimulator.tbd",
                    "-Xlinker", "-weak_library", "-Xlinker",
                    privateHeaders + "/AccessibilityPlatformTranslation/AccessibilityPlatformTranslation.tbd",
                ])
            ]
        ),
    ]
)
