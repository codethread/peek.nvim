declare const Viz: {
  instance(): Promise<{
    renderSVGElement(definition: string): SVGSVGElement;
  }>;
};

let instance: Awaited<ReturnType<typeof Viz.instance>> | undefined;

async function render(definition: string) {
  try {
    instance ||= await Viz.instance();
    return instance.renderSVGElement(definition);
  } catch { /**/ }
}

export default { render };
