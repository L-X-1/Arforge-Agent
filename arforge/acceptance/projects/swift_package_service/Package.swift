// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ArforgeAcceptance",
    products: [
        .library(name: "AcceptanceService", targets: ["AcceptanceService"]),
        .executable(name: "acceptance-cli", targets: ["AcceptanceCLI"]),
    ],
    targets: [
        .target(name: "AcceptanceService"),
        .executableTarget(
            name: "AcceptanceCLI",
            dependencies: ["AcceptanceService"]
        ),
        .testTarget(
            name: "AcceptanceServiceTests",
            dependencies: ["AcceptanceService"]
        ),
    ]
)
