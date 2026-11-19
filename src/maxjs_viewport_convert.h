#pragma once

// Viewport stream pixel conversion: the viewer's 8-bit display pixels to the linear float pixels
// of a Nitrous color target. No 3ds Max types here, so it builds and tests on its own.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string>

namespace MaxJSViewportConvert {

// Display value (0..255 per channel) to the viewport target's linear value.
struct ColorTable {
    float linear[3][256] = {};
    std::uint16_t half[3][256] = {};
    // Used when the channels are not independent: target = matrix * linear.
    float matrix[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
    bool separable = true;
    std::wstring source;
};

const std::uint16_t kHalfOne = 0x3C00;

// Float to half, by table (van der Zijp). Truncates, which is plenty for display values.
struct HalfEncoder {
    std::uint16_t base[512];
    std::uint8_t shift[512];
    HalfEncoder() {
        for (int i = 0; i < 256; ++i) {
            const int e = i - 127;
            std::uint16_t b = 0;
            std::uint8_t s = 24;
            if (e < -24) {
                b = 0x0000;
            } else if (e < -14) {
                b = static_cast<std::uint16_t>(0x0400 >> (-e - 14));
                s = static_cast<std::uint8_t>(-e - 1);
            } else if (e <= 15) {
                b = static_cast<std::uint16_t>((e + 15) << 10);
                s = 13;
            } else {
                b = 0x7C00;
                s = e < 128 ? 24 : 13;
            }
            base[i] = b;
            base[i | 0x100] = static_cast<std::uint16_t>(b | 0x8000);
            shift[i] = s;
            shift[i | 0x100] = s;
        }
    }
    std::uint16_t operator()(float value) const {
        std::uint32_t bits = 0;
        std::memcpy(&bits, &value, sizeof(bits));
        const std::uint32_t index = (bits >> 23) & 0x1FF;
        return static_cast<std::uint16_t>(base[index] + ((bits & 0x007FFFFF) >> shift[index]));
    }
};

inline const HalfEncoder& ToHalf() {
    static const HalfEncoder encoder;
    return encoder;
}

// sRGB transfer function, decoding (IEC 61966-2-1).
inline float SrgbToLinear(float c) {
    return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
}

// Fills the half table from the linear one.
inline void FinishTable(ColorTable& table) {
    const HalfEncoder& toHalf = ToHalf();
    for (int c = 0; c < 3; ++c) {
        for (int v = 0; v < 256; ++v) {
            table.half[c][v] = toHalf(table.linear[c][v]);
        }
    }
}

inline void BuildCurveTable(ColorTable& table, bool decodeSrgb) {
    for (int v = 0; v < 256; ++v) {
        const float value = static_cast<float>(v) / 255.0f;
        const float linear = decodeSrgb ? SrgbToLinear(value) : value;
        table.linear[0][v] = table.linear[1][v] = table.linear[2][v] = linear;
    }
    table.separable = true;
    table.source = decodeSrgb ? L"sRGB decoding" : L"raw values";
    FinishTable(table);
}

struct RowContext {
    const ColorTable* table;
    int redIndex;          // byte offset of red in a source pixel
    int blueIndex;
    bool useAlpha;         // false: every pixel is opaque, whatever its alpha byte says
    bool premultiplied;
    bool backgroundShare;  // output alpha is the background's share: 0 is opaque
};

// The general path: frame alpha, or channels that are not independent.
inline void DecodePixel(const std::uint8_t* source, const RowContext& context, float out[4]) {
    std::uint32_t r = source[context.redIndex];
    std::uint32_t g = source[1];
    std::uint32_t b = source[context.blueIndex];
    float coverage = 1.0f;
    if (context.useAlpha) {
        const std::uint32_t a = source[3];
        coverage = static_cast<float>(a) * (1.0f / 255.0f);
        if (a == 0) {
            out[0] = out[1] = out[2] = 0.0f;
            out[3] = context.backgroundShare ? 1.0f : 0.0f;
            return;
        }
        if (context.premultiplied && a < 255) {
            // The display values were multiplied by alpha: decode the color, not the product.
            r = std::min<std::uint32_t>(255, (r * 255 + a / 2) / a);
            g = std::min<std::uint32_t>(255, (g * 255 + a / 2) / a);
            b = std::min<std::uint32_t>(255, (b * 255 + a / 2) / a);
        }
    }
    const ColorTable& table = *context.table;
    float red = table.linear[0][r];
    float green = table.linear[1][g];
    float blue = table.linear[2][b];
    if (!table.separable) {
        const float* m = table.matrix;
        const float x = red, y = green, z = blue;
        red = m[0] * x + m[1] * y + m[2] * z;
        green = m[3] * x + m[4] * y + m[5] * z;
        blue = m[6] * x + m[7] * y + m[8] * z;
    }
    out[0] = red * coverage;
    out[1] = green * coverage;
    out[2] = blue * coverage;
    out[3] = context.backgroundShare ? 1.0f - coverage : coverage;
}

// To R, G, B, A halves: A16B16G16R16F in memory (DXGI R16G16B16A16_FLOAT).
inline void ConvertRowHalf(const std::uint8_t* source, std::uint16_t* target, std::uint32_t width,
                           const RowContext& context) {
    const ColorTable& table = *context.table;
    const std::uint16_t opaque = context.backgroundShare ? 0 : kHalfOne;
    if (table.separable && !context.useAlpha) {
        for (std::uint32_t x = 0; x < width; ++x, source += 4, target += 4) {
            target[0] = table.half[0][source[context.redIndex]];
            target[1] = table.half[1][source[1]];
            target[2] = table.half[2][source[context.blueIndex]];
            target[3] = opaque;
        }
        return;
    }
    const HalfEncoder& toHalf = ToHalf();
    for (std::uint32_t x = 0; x < width; ++x, source += 4, target += 4) {
        if (table.separable && source[3] == 255) {
            target[0] = table.half[0][source[context.redIndex]];
            target[1] = table.half[1][source[1]];
            target[2] = table.half[2][source[context.blueIndex]];
            target[3] = opaque;
            continue;
        }
        float pixel[4];
        DecodePixel(source, context, pixel);
        target[0] = toHalf(pixel[0]);
        target[1] = toHalf(pixel[1]);
        target[2] = toHalf(pixel[2]);
        target[3] = toHalf(pixel[3]);
    }
}

// To R, G, B, A floats: A32B32G32R32F in memory.
inline void ConvertRowFloat(const std::uint8_t* source, float* target, std::uint32_t width, const RowContext& context) {
    const ColorTable& table = *context.table;
    const float opaque = context.backgroundShare ? 0.0f : 1.0f;
    for (std::uint32_t x = 0; x < width; ++x, source += 4, target += 4) {
        if (table.separable && (!context.useAlpha || source[3] == 255)) {
            target[0] = table.linear[0][source[context.redIndex]];
            target[1] = table.linear[1][source[1]];
            target[2] = table.linear[2][source[context.blueIndex]];
            target[3] = opaque;
            continue;
        }
        DecodePixel(source, context, target);
    }
}

}  // namespace MaxJSViewportConvert
