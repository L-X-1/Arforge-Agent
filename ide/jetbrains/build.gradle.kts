plugins {
    java
    id("org.jetbrains.intellij.platform") version "2.18.1"
}

group = "dev.arforge"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    implementation("com.google.code.gson:gson:2.13.1")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    intellijPlatform {
        val localIde = providers.environmentVariable("ARFORGE_INTELLIJ_SDK")
        if (localIde.isPresent) {
            local(localIde.get())
        } else {
            intellijIdeaCommunity("2024.1.7")
        }
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "241"
        }
        vendor {
            name = "Arforge Agent"
            email = "support@arforge.dev"
        }
    }
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(17)
    }
}

tasks {
    test {
        useJUnitPlatform()
    }
}
