describe('Webextension Popup', () => {
  it('should open the popup with the Dock sections', async () => {
    const extensionPath = await browser.getExtensionPath();
    await browser.url(`${extensionPath}/popup/index.html`);

    await expect(browser).toHaveTitle('Dock');
    await expect($('#tab-ship')).toBeExisting();
    await expect($('#tab-manifest')).toBeExisting();
    await expect($('#tab-ai')).toBeExisting();
  });
});
