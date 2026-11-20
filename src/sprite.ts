export function spriteElement(url: string, label: string, animatedVideo = false) {
  if (!animatedVideo) {
    const image = document.createElement('img');
    image.alt = label;
    image.src = url;
    return image;
  }
  const video = document.createElement('video');
  video.setAttribute('aria-label', label);
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.loop = true;
  video.preload = 'auto';
  video.autoplay = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  video.src = url;
  return video;
}
