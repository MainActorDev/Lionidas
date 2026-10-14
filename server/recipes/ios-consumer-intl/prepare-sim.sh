#!/bin/sh
# .lionidas/scripts/prepare-sim.sh — simulator build setup for CI/Lionidas, invoked via
# lionidas.yml (`prepare: - run: scripts/prepare-sim.sh`). Idempotent: safe on
# warm caches. Plain sh — no fastlane/bundler dependency, any runner works.
#
# Why: a bare clone cannot produce a RUNNABLE app. project.yml references
# .xcconfig files that are never committed (secret environments), and the
# prebuilt XCFrameworks are not in git. Stripping the config (the naive fix)
# builds GREEN but ships empty env keys — the app crashes on launch with
# "API_BASE_URL is missing or malformed". This script wires a real config.
#
# Steps:
#   0. Prereq + toolchain guards (AGENTS.md law: XCFrameworks are
#      Xcode-version-bound — rebuild scipio whenever Xcode changes).
#   1. Config wiring: use the developer's own .xcconfig when present; else
#      StagingAutomationConfig (committed, automation-safe staging values);
#      else strip (last resort — prints a loud warning).
#   2. xcodegen from the rewritten spec.
#   3. Scipio when XCFrameworks/ is empty or the toolchain stamp changed.
#   4. SPM resolve into .spm-clones.
set -eu
cd "$(dirname "$0")/../.."

# ── 0/4 prerequisites (named failures; see scripts/bootstrap.sh to install) ──
for tool in ruby xcodegen xcodebuild make; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "PREPARE_FAILED: '$tool' not found — run scripts/bootstrap.sh first" >&2
    exit 2
  fi
done

# ── toolchain guard: rebuild scipio when Xcode changes (AGENTS.md law) ──
TOOLCHAIN="$(xcodebuild -version | shasum | cut -d' ' -f1)"
STAMP=".lionidas/.scipio-toolchain-stamp"
NEED_SCIPIO=0
if [ -z "$(ls -A XCFrameworks 2>/dev/null)" ]; then
  NEED_SCIPIO=1        # no prebuilts at all (fresh clone)
elif [ ! -f "$STAMP" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$TOOLCHAIN" ]; then
  NEED_SCIPIO=1        # Xcode changed since the prebuilts were built
fi

# ── 1/4 config wiring: local dev config > automation config > strip ──
SPEC="project.lionidas-sim.yml"
AUTOMATION_XCCONFIG="$(dirname "$0")/../StagingAutomationConfig.xcconfig"
# dev config parked in .lionidas/ (repo-ignored at App/) → place it where the
# unmodified spec expects it (drill catch: xcodegen hard-fails on missing paths)
if [ ! -f "App/Config/Environments/DevelopmentConfig.xcconfig" ] && [ -f "$(dirname "$0")/../DevelopmentConfig.xcconfig" ]; then
  mkdir -p "App/Config/Environments"
  cp "$(dirname "$0")/../DevelopmentConfig.xcconfig" "App/Config/Environments/DevelopmentConfig.xcconfig"
  echo "[prepare-sim] 1/4 config: placed developer config from .lionidas/"
fi
# place the automation xcconfig at the spec-referenced path (both branches rewire to it)
if [ -f "$AUTOMATION_XCCONFIG" ]; then
  mkdir -p "App/Config/Environments"
  cp "$AUTOMATION_XCCONFIG" "App/Config/Environments/StagingAutomationConfig.xcconfig"
fi
if [ -f "App/Config/Environments/DevelopmentConfig.xcconfig" ]; then
  echo "[prepare-sim] 1/4 config: developer config present — spec as-is, missing configs → automation"
  cp project.yml "$SPEC"
  # a dev machine carries DevelopmentConfig only; Staging/Production/Release
  # entries point at repo-ignored paths that don't exist — rewire those to the
  # automation config or xcodegen's path validation fails (drill catch)
  ruby -e '
    require "yaml"
    spec_path = "project.lionidas-sim.yml"
    spec = YAML.load_file(spec_path)
    automation = "App/Config/Environments/StagingAutomationConfig.xcconfig"
    (spec["targets"] || {}).each_value do |t|
      cf = t["configFiles"] or next
      cf.each do |k, v|
        next if v && File.exist?(File.expand_path(v.to_s, Dir.pwd))
        cf[k] = automation
      end
    end
    File.write(spec_path, YAML.dump(spec))
  '
  # stamping (Lionidas T2): CFBundleVersion = the CI build number when the
  # runner exports it; unset (dev machine) keeps the repo literal untouched
  if [ -n "${LIONIDAS_BUILD_NUMBER:-}" ]; then
    ruby -e '
      require "yaml"
      spec = YAML.load_file("project.lionidas-sim.yml")
      # target-level settings OVERRIDE project-level — the repo pins
      # CURRENT_PROJECT_VERSION under settings.base (xcodegen shape:
      # settings: { base: {...}, configs: {...} }); stamp it there AND at
      # project level for targets that inherit
      (spec["settings"] ||= {})["CURRENT_PROJECT_VERSION"] = ENV["LIONIDAS_BUILD_NUMBER"]
      (spec["targets"] || {}).each_value do |t|
        ts = t["settings"]
        next unless ts.is_a?(Hash)
        base = ts["base"]
        if base.is_a?(Hash) && base.key?("CURRENT_PROJECT_VERSION")
          base["CURRENT_PROJECT_VERSION"] = ENV["LIONIDAS_BUILD_NUMBER"]
        elsif ts.key?("CURRENT_PROJECT_VERSION")
          ts["CURRENT_PROJECT_VERSION"] = ENV["LIONIDAS_BUILD_NUMBER"]
        end
      end
      File.write("project.lionidas-sim.yml", YAML.dump(spec))
    '
    echo "[prepare-sim] stamped CURRENT_PROJECT_VERSION=${LIONIDAS_BUILD_NUMBER}"
  fi
elif [ -f "$AUTOMATION_XCCONFIG" ]; then
  echo "[prepare-sim] 1/4 config: no local secrets — wiring StagingAutomationConfig"
  ruby -e '
    require "yaml"
    root = Dir.pwd
    spec = YAML.load_file(File.join(root, "project.yml"))
    automation = "App/Config/Environments/StagingAutomationConfig.xcconfig"
    targets = spec["targets"] || {}
    targets.each_value do |t|
      cf = t["configFiles"] or next
      # replace every config entry pointing at a MISSING file with the
      # committed automation config; present files keep their local secrets
      cf.each do |k, v|
        next if v && File.exist?(File.expand_path(v.to_s, root))
        cf[k] = automation
      end
    end
    File.write("project.lionidas-sim.yml", YAML.dump(spec))
  '
  # stamping (Lionidas T2): CFBundleVersion = the CI build number when the
  # runner exports it; unset (dev machine) keeps the repo literal untouched
  if [ -n "${LIONIDAS_BUILD_NUMBER:-}" ]; then
    ruby -e '
      require "yaml"
      spec = YAML.load_file("project.lionidas-sim.yml")
      # target-level settings OVERRIDE project-level — the repo pins
      # CURRENT_PROJECT_VERSION under settings.base (xcodegen shape:
      # settings: { base: {...}, configs: {...} }); stamp it there AND at
      # project level for targets that inherit
      (spec["settings"] ||= {})["CURRENT_PROJECT_VERSION"] = ENV["LIONIDAS_BUILD_NUMBER"]
      (spec["targets"] || {}).each_value do |t|
        ts = t["settings"]
        next unless ts.is_a?(Hash)
        base = ts["base"]
        if base.is_a?(Hash) && base.key?("CURRENT_PROJECT_VERSION")
          base["CURRENT_PROJECT_VERSION"] = ENV["LIONIDAS_BUILD_NUMBER"]
        elsif ts.key?("CURRENT_PROJECT_VERSION")
          ts["CURRENT_PROJECT_VERSION"] = ENV["LIONIDAS_BUILD_NUMBER"]
        end
      end
      File.write("project.lionidas-sim.yml", YAML.dump(spec))
    '
    echo "[prepare-sim] stamped CURRENT_PROJECT_VERSION=${LIONIDAS_BUILD_NUMBER}"
  fi
else
  echo "[prepare-sim] 1/4 config: WARNING — no local secrets and no automation config;" >&2
  echo "  stripping configFiles: the build will ship EMPTY environment keys and CRASH ON LAUNCH" >&2
  ruby -e '
    require "yaml"
    root = Dir.pwd
    spec = YAML.load_file(File.join(root, "project.yml"))
    targets = spec["targets"] || {}
    targets.each_value do |t|
      cf = t["configFiles"] or next
      missing = cf.values.any? { |p| p && !File.exist?(File.expand_path(p.to_s, root)) }
      t.delete("configFiles") if missing
    end
    File.write("project.lionidas-sim.yml", YAML.dump(spec))
  '
  # stamping (Lionidas T2): CFBundleVersion = the CI build number when the
  # runner exports it; unset (dev machine) keeps the repo literal untouched
  if [ -n "${LIONIDAS_BUILD_NUMBER:-}" ]; then
    ruby -e '
      require "yaml"
      spec = YAML.load_file("project.lionidas-sim.yml")
      # target-level settings OVERRIDE project-level — the repo pins
      # CURRENT_PROJECT_VERSION under settings.base (xcodegen shape:
      # settings: { base: {...}, configs: {...} }); stamp it there AND at
      # project level for targets that inherit
      (spec["settings"] ||= {})["CURRENT_PROJECT_VERSION"] = ENV["LIONIDAS_BUILD_NUMBER"]
      (spec["targets"] || {}).each_value do |t|
        ts = t["settings"]
        next unless ts.is_a?(Hash)
        base = ts["base"]
        if base.is_a?(Hash) && base.key?("CURRENT_PROJECT_VERSION")
          base["CURRENT_PROJECT_VERSION"] = ENV["LIONIDAS_BUILD_NUMBER"]
        elsif ts.key?("CURRENT_PROJECT_VERSION")
          ts["CURRENT_PROJECT_VERSION"] = ENV["LIONIDAS_BUILD_NUMBER"]
        end
      end
      File.write("project.lionidas-sim.yml", YAML.dump(spec))
    '
    echo "[prepare-sim] stamped CURRENT_PROJECT_VERSION=${LIONIDAS_BUILD_NUMBER}"
  fi
fi
echo "[prepare-sim] 2/4 xcodegen"
xcodegen generate --spec "$SPEC"

# ── 3/4 scipio (toolchain-aware) ──
if [ "$NEED_SCIPIO" = "1" ]; then
  echo "[prepare-sim] 3/4 scipio: building XCFrameworks (toolchain ${TOOLCHAIN%???????????????????????????????????????}…)"
  make scipio
  printf '%s\n' "$TOOLCHAIN" > "$STAMP"
else
  echo "[prepare-sim] 3/4 scipio: cached (toolchain unchanged)"
fi

# ── 4/4 SPM resolve ──
echo "[prepare-sim] 4/4 SPM resolve into .spm-clones"
xcodebuild -resolvePackageDependencies \
  -clonedSourcePackagesDirPath .spm-clones \
  -project LionParcelLogisticsINTL.xcodeproj
echo "[prepare-sim] done"
