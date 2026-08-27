import { ImageResponse } from "next/og";
import { readFileSync } from "fs";
import { join } from "path";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  const logoBuffer = readFileSync(join(process.cwd(), "public", "logo.png"));
  const logoSrc = `data:image/png;base64,${logoBuffer.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
          gap: 36,
        }}
      >
        <img src={logoSrc} width={218} height={241} alt="" />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              fontSize: 58,
              fontWeight: 700,
              color: "#111111",
              letterSpacing: -1,
            }}
          >
            TECKTAL TUTOR
          </div>
          <div style={{ fontSize: 28, color: "#666666" }}>
            Agent-native intelligent learning companion
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
