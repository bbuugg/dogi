/**
 * 错误文案的解析（`httpErrorMessage`）。
 *
 * 这条测试在防一个真实回归：502 / 504 是前面的反向代理直接回的，正文是一整页 HTML。
 * 以前把正文前 200 字当消息，前端就把它 toast 出来（用户看到 `<!DOCTYPE html>...`）。
 * 非 JSON 的正文一律只报状态码 + 人话，只有 `{ error }` / `{ message }` 才透传。
 */
import { describe, expect, it } from "vitest";
import { httpErrorMessage } from "./api";

const HTML_502 =
  '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>';

describe("httpErrorMessage", () => {
  it("代理回 HTML 时只报状态码文案，HTML 不进消息", () => {
    const message = httpErrorMessage(502, HTML_502);
    expect(message).toBe("HTTP 502 网关错误，后端服务可能没起来");
    expect(message).not.toContain("<");
  });

  it("正文为空时按状态码兜底", () => {
    expect(httpErrorMessage(504, "")).toBe(
      "HTTP 504 网关超时，后端服务没有响应",
    );
  });

  it("本服务的 { error } 原样透出", () => {
    expect(httpErrorMessage(400, JSON.stringify({ error: "工作区不存在" }))).toBe(
      "工作区不存在",
    );
  });

  it("JSON 里的 { message } 也认", () => {
    expect(httpErrorMessage(400, JSON.stringify({ message: "参数不对" }))).toBe(
      "参数不对",
    );
  });

  it("未知状态码只报数字", () => {
    expect(httpErrorMessage(418, "")).toBe("HTTP 418");
  });
});
