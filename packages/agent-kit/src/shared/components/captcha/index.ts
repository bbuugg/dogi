/**
 * 滑块验证码：本仓库内置实现（无外部服务 / 无 SDK）。
 *
 * 服务端在 `apps/server/src/lib/captcha`，前端在这里。两端共用 `@fizz/contracts` 里的
 * `CaptchaChallenge` / `CaptchaAnswer` / `CaptchaVerifyResponse`。
 */
export { SliderCaptcha, type CaptchaStatus, type SliderCaptchaProps } from './SliderCaptcha'
export { useCaptcha, type CaptchaController } from './use-captcha'
export { TrackRecorder } from './track'
