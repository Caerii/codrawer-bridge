/**
 * Drawing over the world: the phone camera as the stage's backdrop instead of paper.
 *
 * The preferred source is live video from the back camera (getUserMedia), with a freeze button to
 * hold a frame and draw over a moment. Not every WebView grants live video; then we fall back to
 * the Even app's own camera through the SDK, which returns one still photo. Over a backdrop the
 * stage draws ink white with a dark halo so it reads over any scene (stage.ts).
 */
import { glasses, hud } from '../state'
import { stage } from './screen'

const camBtn = document.getElementById('camBtn') as HTMLButtonElement
const freezeBtn = document.getElementById('freezeBtn') as HTMLButtonElement
const video = document.getElementById('camera') as HTMLVideoElement
let camStream: MediaStream | null = null

/** Back to paper: stop the camera and drop the backdrop. */
function stopCamera() {
  camStream?.getTracks().forEach((t) => t.stop())
  camStream = null
  video.srcObject = null
  stage.setBackdrop(null)
  camBtn.setAttribute('aria-pressed', 'false')
  camBtn.title = 'Draw over the camera'
  freezeBtn.hidden = true
}

/** Live video if the WebView grants it, else one photo from the Even app's camera. */
async function startCamera() {
  camBtn.title = 'Starting the camera…'
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable')
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    })
    video.srcObject = camStream
    await video.play()
    stage.setBackdrop(video)
    camBtn.setAttribute('aria-pressed', 'true')
    camBtn.title = 'Back to paper'
    freezeBtn.hidden = false
    freezeBtn.setAttribute('aria-pressed', 'false')
    console.log('[codrawer] camera live', video.videoWidth, 'x', video.videoHeight)
    return
  } catch (e) {
    console.warn('[codrawer] live camera unavailable; trying a photo', String(e))
  }
  try {
    const sdk = glasses.sdk
    const shot = sdk ? await sdk.captureImageFromCamera() : null
    if (!shot?.base64) throw new Error(sdk ? 'no photo taken' : 'no Even bridge')
    const img = new Image()
    img.src = shot.base64.startsWith('data:') ? shot.base64 : `data:${shot.mimeType || 'image/jpeg'};base64,${shot.base64}`
    await img.decode()
    stage.setBackdrop(img)
    camBtn.setAttribute('aria-pressed', 'true')
    camBtn.title = 'Back to paper'
    console.log('[codrawer] camera photo', img.naturalWidth, 'x', img.naturalHeight)
  } catch (e) {
    console.warn('[codrawer] camera unavailable', String(e))
    camBtn.title = 'Camera unavailable'
    hud.notice = 'camera unavailable'
  }
}

/** Wire the camera and freeze buttons. */
export function setupCamera() {
  camBtn.onclick = () => (stage.hasBackdrop ? stopCamera() : void startCamera())
  // Freeze holds the current frame so you can draw over a moment; tap again to go live.
  freezeBtn.onclick = () => {
    if (video.paused) {
      void video.play()
      freezeBtn.setAttribute('aria-pressed', 'false')
    } else {
      video.pause()
      freezeBtn.setAttribute('aria-pressed', 'true')
    }
    stage.touch()
  }
}
