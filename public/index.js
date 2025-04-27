document.getElementById('uv-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  const address = document.getElementById('uv-address').value.trim();
  if (!address) return;

  try {
    const url = address.includes('.') ? address : `https://www.google.com/search?q=${encodeURIComponent(address)}`;
    const encodedUrl = __uv$config.encodeUrl(url);
    window.location.href = __uv$config.prefix + encodedUrl;
  } catch (error) {
    console.error('Error processing URL:', error);
    alert('Failed to process the URL. Please try again.');
  }
});
