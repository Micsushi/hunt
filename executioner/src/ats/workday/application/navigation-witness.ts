export function armNavigationWitness(input: { readonly rootSelector: string; readonly actionId: string }): boolean {
  const root = document.querySelector<HTMLElement>(input.rootSelector);
  if (root === null) return false;
  const controller = root.closest<HTMLElement>('[data-automation-id="applyFlowPage"]') ?? root;
  const globalState = globalThis as unknown as Record<string, unknown>;
  const prior = globalState.__huntWorkdayNavigationAction as {
    observer?: MutationObserver;
    restoreInstrumentation?: () => void;
  } | undefined;
  prior?.observer?.disconnect();
  prior?.restoreInstrumentation?.();
  const state = {
    actionId: input.actionId,
    controller,
    clicked: false,
    busySeen: false,
    settled: false,
    frozen: false,
    instrumentationComplete: true,
    activeBusy: new Map<object, {
      readonly source: "class" | "other";
      readonly styleDependent: boolean;
      readonly styleContextToken?: string;
      readonly styleContextVersion: number;
    }>(),
    settledPairs: [] as {
      readonly key: object;
      readonly styleDependent: boolean;
      readonly styleContextToken?: string;
    }[],
    styleContextVersion: 0,
    armedStyleContextToken: undefined as string | undefined,
    sampleStyleContext: undefined as (() => string | undefined) | undefined,
    syncWitnessState: undefined as (() => void) | undefined,
    restoreInstrumentation: undefined as (() => void) | undefined,
    observer: undefined as MutationObserver | undefined,
  };
  type LoaderAttributes = {
    hidden: string | null;
    ariaHidden: string | null;
    style: string | null;
    className: string | null;
  };
  const loaderSelector = '[data-automation-id="applyFlowLoadingPage"]';
  const visible = (element: Element): boolean => {
    if (!(element instanceof HTMLElement) || !element.isConnected ||
        !controller.contains(element) || element.hidden ||
        element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" &&
      style.visibility !== "collapse" && element.getClientRects().length > 0;
  };
  const attributes = (element: Element): LoaderAttributes => ({
    hidden: element.getAttribute("hidden"),
    ariaHidden: element.getAttribute("aria-hidden"),
    style: element.getAttribute("style"),
    className: element.getAttribute("class"),
  });
  const loaderStates = new Map<Element, { attributes: LoaderAttributes; visible: boolean }>();
  const exactAttributeCaptures = new Map<Element, {
    readonly name: string;
    readonly oldValue: string | null;
  }[]>();
  let sampleStyleContext = (): string | undefined => undefined;
  let armedStyleContextToken: string | undefined;
  const register = (element: Element) => {
    if (!element.matches(loaderSelector) ||
        element.hasAttribute("data-hunt-render-probe") || !controller.contains(element)) return;
    loaderStates.set(element, { attributes: attributes(element), visible: visible(element) });
  };
  controller.querySelectorAll(loaderSelector).forEach(register);
  const syncWitnessState = () => {
    state.busySeen = state.activeBusy.size > 0 || state.settledPairs.length > 0;
    state.settled = state.settledPairs.length > 0 && state.activeBusy.size === 0;
    if (state.settled && controller.isConnected) {
      globalState.__huntWorkdayNavigationWitness = state.actionId;
    } else if (globalState.__huntWorkdayNavigationWitness === state.actionId) {
      delete globalState.__huntWorkdayNavigationWitness;
    }
  };
  state.syncWitnessState = syncWitnessState;
  const invalidateStyleContext = () => {
    if (!state.clicked || state.frozen) return;
    state.styleContextVersion += 1;
    for (const [key, active] of state.activeBusy) {
      if (active.styleDependent) state.activeBusy.delete(key);
    }
    state.settledPairs = state.settledPairs.filter((pair) => !pair.styleDependent);
    syncWitnessState();
  };
  const recordLoaderTransition = (
    key: object,
    wasVisible: boolean,
    isVisible: boolean,
    source: "class" | "other",
    styleToken?: string,
    styleDependent = false,
  ) => {
    if (!state.clicked || wasVisible === isVisible) return;
    if (styleToken !== undefined && (
      armedStyleContextToken === undefined || styleToken !== armedStyleContextToken
    )) {
      invalidateStyleContext();
      return;
    }
    const transitionStyleDependent = source === "class" || styleDependent;
    if (transitionStyleDependent && (
      !state.instrumentationComplete || styleToken === undefined
    )) {
      invalidateStyleContext();
      return;
    }
    if (isVisible) {
      state.activeBusy.set(key, {
        source,
        styleDependent: transitionStyleDependent,
        styleContextToken: styleToken,
        styleContextVersion: state.styleContextVersion,
      });
    } else {
      const active = state.activeBusy.get(key);
      if (active === undefined) return;
      const pairStyleDependent = active.styleDependent || transitionStyleDependent;
      state.activeBusy.delete(key);
      if (pairStyleDependent && (
        armedStyleContextToken === undefined ||
        active.styleContextVersion !== state.styleContextVersion ||
        active.styleContextToken !== armedStyleContextToken ||
        styleToken !== armedStyleContextToken
      )) {
        invalidateStyleContext();
        return;
      }
      state.settledPairs.push({
        key,
        styleDependent: pairStyleDependent,
        styleContextToken: pairStyleDependent ? active.styleContextToken : undefined,
      });
    }
    syncWitnessState();
  };
  const captureExactLoaderState = (
    element: Element,
    source: "class" | "other",
    attributeName: "class" | "hidden" | "aria-hidden" | "style",
  ) => {
    if (!element.matches(loaderSelector) || !controller.contains(element) ||
        element.hasAttribute("data-hunt-render-probe")) return;
    const known = loaderStates.get(element) ?? {
      attributes: attributes(element),
      visible: visible(element),
    };
    const priorAttributes = known.attributes;
    const nextAttributes = attributes(element);
    const attributeKey = attributeName === "aria-hidden" ? "ariaHidden"
      : attributeName === "class" ? "className"
      : attributeName as keyof LoaderAttributes;
    if (priorAttributes[attributeKey] !== nextAttributes[attributeKey]) {
      const captures = exactAttributeCaptures.get(element) ?? [];
      captures.push({ name: attributeName, oldValue: priorAttributes[attributeKey] });
      exactAttributeCaptures.set(element, captures);
    }
    const styleToken = sampleStyleContext();
    if (styleToken === undefined || styleToken !== armedStyleContextToken) {
      invalidateStyleContext();
    }
    const nextVisible = visible(element);
    recordLoaderTransition(element, known.visible, nextVisible, source, styleToken, true);
    known.visible = nextVisible;
    known.attributes = nextAttributes;
    loaderStates.set(element, known);
  };
  const observerOptions: MutationObserverInit = {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true,
  };
  const sheetIds = new WeakMap<CSSStyleSheet, number>();
  let nextSheetId = 0;
  const sheetId = (sheet: CSSStyleSheet): number => {
    const existing = sheetIds.get(sheet);
    if (existing !== undefined) return existing;
    nextSheetId += 1;
    sheetIds.set(sheet, nextSheetId);
    return nextSheetId;
  };
  const styleContextToken = (): string => JSON.stringify([
    ...[...document.styleSheets].map((sheet) => sheet as CSSStyleSheet),
    ...("adoptedStyleSheets" in document ? [...document.adoptedStyleSheets] : []),
  ].map((sheet) => {
    let rules: string;
    try {
      rules = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
    } catch {
      state.instrumentationComplete = false;
      rules = "inaccessible";
    }
    const owner = sheet.ownerNode instanceof Element ? sheet.ownerNode : null;
    return {
      id: sheetId(sheet),
      rules,
      href: sheet.href ?? "",
      disabled: sheet.disabled,
      media: sheet.media.mediaText,
      owner: owner === null ? "" : [...owner.attributes]
        .map(({ name, value }) => `${name}=${value}`).sort().join("|"),
    };
  }));
  const rulesUseStructure = (
    rules: CSSRuleList,
    selectorMatches: (selector: string) => boolean,
  ): boolean => {
    for (const rule of [...rules]) {
      if ("selectorText" in rule && typeof (rule as CSSStyleRule).selectorText === "string" &&
          selectorMatches((rule as CSSStyleRule).selectorText)) return true;
      if ("cssRules" in rule && (rule as { cssRules?: unknown }).cssRules instanceof CSSRuleList &&
          rulesUseStructure(
            (rule as unknown as { cssRules: CSSRuleList }).cssRules,
            selectorMatches,
          )) {
        return true;
      }
    }
    return false;
  };
  const sheetsUseStructure = (selectorMatches: (selector: string) => boolean): boolean => [
    ...[...document.styleSheets].map((candidate) => candidate as CSSStyleSheet),
    ...("adoptedStyleSheets" in document ? [...document.adoptedStyleSheets] : []),
  ].some((sheet) => {
    try {
      return rulesUseStructure(sheet.cssRules, selectorMatches);
    } catch {
      state.instrumentationComplete = false;
      return true;
    }
  });
  const globalStructureCanAffectLoader = sheetsUseStructure((selector) =>
    /:has\(/iu.test(selector)
  );
  const localStructureCanAffectLoader = sheetsUseStructure((selector) =>
    /[+~]|:(?:first-child|last-child|only-child|nth-child|nth-last-child|first-of-type|last-of-type|only-of-type|nth-of-type|nth-last-of-type|empty)\b/iu.test(selector)
  );
  const initialStyleContextToken = styleContextToken();
  armedStyleContextToken = state.instrumentationComplete ? initialStyleContextToken : undefined;
  sampleStyleContext = () => {
    const token = styleContextToken();
    return state.instrumentationComplete ? token : undefined;
  };
  state.armedStyleContextToken = armedStyleContextToken;
  state.sampleStyleContext = sampleStyleContext;
  const restorers: (() => void)[] = [];
  const nativeDeclarationSetProperty = CSSStyleDeclaration.prototype.setProperty;
  const nativeDeclarationRemoveProperty = CSSStyleDeclaration.prototype.removeProperty;
  const nativeDeclarationGetPropertyValue = CSSStyleDeclaration.prototype.getPropertyValue;
  const instrumentDeclarationInstance = (
    declaration: CSSStyleDeclaration,
    loader?: HTMLElement,
  ) => {
    for (const name of Object.getOwnPropertyNames(declaration)) {
      if (/^\d+$/u.test(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(declaration, name);
      if (descriptor === undefined || descriptor.configurable !== true ||
          !("value" in descriptor) || descriptor.writable !== true) continue;
      const cssName = name === "cssFloat" ? "float" : name
        .replace(/^ms/u, "-ms")
        .replace(/[A-Z]/gu, (letter) => `-${letter.toLocaleLowerCase("en-US")}`);
      const getter = () => nativeDeclarationGetPropertyValue.call(declaration, cssName);
      const setter = (value: unknown) => {
        if (loader === undefined) invalidateStyleContext();
        const normalized = String(value);
        if (normalized === "") nativeDeclarationRemoveProperty.call(declaration, cssName);
        else nativeDeclarationSetProperty.call(declaration, cssName, normalized);
        if (loader !== undefined) captureExactLoaderState(loader, "other", "style");
      };
      try {
        Object.defineProperty(declaration, name, {
          configurable: true,
          enumerable: descriptor.enumerable ?? true,
          get: getter,
          set: setter,
        });
        restorers.push(() => {
          const current = Object.getOwnPropertyDescriptor(declaration, name);
          if (current?.get === getter && current.set === setter) {
            Object.defineProperty(declaration, name, {
              ...descriptor,
              value: nativeDeclarationGetPropertyValue.call(declaration, cssName),
            });
          }
        });
      } catch {
        state.instrumentationComplete = false;
      }
    }
  };
  const instrumentRuleDeclarations = (rules: CSSRuleList) => {
    for (const rule of [...rules]) {
      if ("style" in rule && (rule as { style?: unknown }).style instanceof CSSStyleDeclaration) {
        instrumentDeclarationInstance((rule as unknown as { style: CSSStyleDeclaration }).style);
      }
      if ("cssRules" in rule && (rule as { cssRules?: unknown }).cssRules instanceof CSSRuleList) {
        instrumentRuleDeclarations((rule as unknown as { cssRules: CSSRuleList }).cssRules);
      }
    }
  };
  for (const sheet of [
    ...[...document.styleSheets].map((candidate) => candidate as CSSStyleSheet),
    ...("adoptedStyleSheets" in document ? [...document.adoptedStyleSheets] : []),
  ]) {
    try {
      instrumentRuleDeclarations(sheet.cssRules);
    } catch {
      state.instrumentationComplete = false;
    }
  }
  for (const loader of controller.querySelectorAll<HTMLElement>(loaderSelector)) {
    instrumentDeclarationInstance(loader.style, loader);
  }
  const instrumentMethod = (
    requestedPrototype: object | undefined,
    name: string,
    affectsStyle: (receiver: unknown) => boolean = () => true,
    after?: (receiver: unknown, args: readonly unknown[]) => void,
  ) => {
    if (requestedPrototype === undefined) return;
    let prototype: object | null = requestedPrototype;
    let descriptor: PropertyDescriptor | undefined;
    while (prototype !== null && descriptor === undefined) {
      descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor === undefined) prototype = Object.getPrototypeOf(prototype) as object | null;
    }
    if (prototype === null) {
      if (name in requestedPrototype) state.instrumentationComplete = false;
      return;
    }
    if (descriptor?.value === undefined || typeof descriptor.value !== "function" ||
        descriptor.configurable !== true) {
      if (name in requestedPrototype) state.instrumentationComplete = false;
      return;
    }
    const original = descriptor.value as (...args: unknown[]) => unknown;
    const wrapped = function(this: unknown, ...args: unknown[]) {
      if (affectsStyle(this)) invalidateStyleContext();
      const result = original.apply(this, args);
      after?.(this, args);
      return result;
    };
    Object.defineProperty(prototype, name, { ...descriptor, value: wrapped });
    restorers.push(() => {
      if ((prototype as Record<string, unknown>)[name] === wrapped) {
        Object.defineProperty(prototype, name, descriptor);
      }
    });
  };
  const instrumentSetter = (
    requestedPrototype: object | undefined,
    name: string,
    affectsStyle: (receiver: unknown) => boolean = () => true,
    after?: (receiver: unknown, value: unknown) => void,
  ) => {
    if (requestedPrototype === undefined) return;
    let prototype: object | null = requestedPrototype;
    let descriptor: PropertyDescriptor | undefined;
    while (prototype !== null && descriptor === undefined) {
      descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor === undefined) prototype = Object.getPrototypeOf(prototype) as object | null;
    }
    if (prototype === null) {
      if (name in requestedPrototype) state.instrumentationComplete = false;
      return;
    }
    if (descriptor?.set === undefined || descriptor.configurable !== true) {
      if (name in requestedPrototype) state.instrumentationComplete = false;
      return;
    }
    const original = descriptor.set;
    const wrapped = function(this: unknown, value: unknown) {
      if (affectsStyle(this)) invalidateStyleContext();
      original.call(this, value);
      after?.(this, value);
    };
    Object.defineProperty(prototype, name, { ...descriptor, set: wrapped });
    restorers.push(() => {
      if (Object.getOwnPropertyDescriptor(prototype, name)?.set === wrapped) {
        Object.defineProperty(prototype, name, descriptor);
      }
    });
  };
  for (const name of ["insertRule", "deleteRule", "replace", "replaceSync"]) {
    instrumentMethod(CSSStyleSheet.prototype, name);
  }
  const groupingPrototype = (globalThis as unknown as {
    CSSGroupingRule?: { prototype: object };
  }).CSSGroupingRule?.prototype;
  const mediaRulePrototype = (globalThis as unknown as {
    CSSMediaRule?: { prototype: object };
  }).CSSMediaRule?.prototype;
  for (const name of ["insertRule", "deleteRule"]) {
    instrumentMethod(groupingPrototype ?? mediaRulePrototype, name);
  }
  const ownedLoaderForStyle = (receiver: unknown): HTMLElement | undefined =>
    [...controller.querySelectorAll<HTMLElement>(loaderSelector)]
      .find((loader) => loader.style === receiver);
  const styleDeclarationAffectsClassContext = (receiver: unknown): boolean =>
    ownedLoaderForStyle(receiver) === undefined;
  const captureOwnedLoaderStyle = (receiver: unknown) => {
    const loader = ownedLoaderForStyle(receiver);
    if (loader !== undefined) captureExactLoaderState(loader, "other", "style");
  };
  for (const name of ["setProperty", "removeProperty"]) {
    instrumentMethod(
      CSSStyleDeclaration.prototype,
      name,
      styleDeclarationAffectsClassContext,
      captureOwnedLoaderStyle,
    );
  }
  instrumentSetter(
    CSSStyleDeclaration.prototype,
    "cssText",
    styleDeclarationAffectsClassContext,
    captureOwnedLoaderStyle,
  );
  for (const name of Object.getOwnPropertyNames(CSSStyleDeclaration.prototype)) {
    if (name === "cssText" || /^[-_]/u.test(name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, name);
    if (descriptor?.set === undefined) continue;
    instrumentSetter(
      CSSStyleDeclaration.prototype,
      name,
      styleDeclarationAffectsClassContext,
      captureOwnedLoaderStyle,
    );
  }
  instrumentSetter(CSSStyleSheet.prototype, "disabled");
  const styleRulePrototype = (globalThis as unknown as {
    CSSStyleRule?: { prototype: object };
  }).CSSStyleRule?.prototype;
  instrumentSetter(styleRulePrototype, "selectorText");
  const keyframeRulePrototype = (globalThis as unknown as {
    CSSKeyframeRule?: { prototype: object };
  }).CSSKeyframeRule?.prototype;
  instrumentSetter(keyframeRulePrototype, "keyText");
  const keyframesRulePrototype = (globalThis as unknown as {
    CSSKeyframesRule?: { prototype: object };
  }).CSSKeyframesRule?.prototype;
  for (const name of ["appendRule", "deleteRule"]) {
    instrumentMethod(keyframesRulePrototype, name);
  }
  const mediaListPrototype = (globalThis as unknown as {
    MediaList?: { prototype: object };
  }).MediaList?.prototype;
  instrumentSetter(mediaListPrototype, "mediaText");
  for (const name of ["appendMedium", "deleteMedium"]) {
    instrumentMethod(mediaListPrototype, name);
  }
  const elementPrototype = Element.prototype;
  const classDescriptor = Object.getOwnPropertyDescriptor(elementPrototype, "className");
  if (classDescriptor?.set === undefined || classDescriptor.configurable !== true) {
    state.instrumentationComplete = false;
  } else {
    const original = classDescriptor.set;
    const wrapped = function(this: Element, value: string) {
      original.call(this, value);
      captureExactLoaderState(this, "class", "class");
    };
    Object.defineProperty(elementPrototype, "className", { ...classDescriptor, set: wrapped });
    restorers.push(() => {
      if (Object.getOwnPropertyDescriptor(elementPrototype, "className")?.set === wrapped) {
        Object.defineProperty(elementPrototype, "className", classDescriptor);
      }
    });
  }
  const captureAttributeState = (receiver: unknown, rawName: unknown) => {
    if (!(receiver instanceof Element) || typeof rawName !== "string") return;
    const name = rawName.toLocaleLowerCase("en-US");
    if (name === "class") captureExactLoaderState(receiver, "class", "class");
    else if (["hidden", "aria-hidden", "style"].includes(name)) {
      captureExactLoaderState(
        receiver,
        "other",
        name as "hidden" | "aria-hidden" | "style",
      );
    }
  };
  for (const name of ["setAttribute", "removeAttribute"]) {
    instrumentMethod(elementPrototype, name, () => false, (receiver, args) => {
      captureAttributeState(receiver, args[0]);
    });
  }
  instrumentMethod(elementPrototype, "setAttributeNS", () => false, (receiver, args) => {
    captureAttributeState(receiver, args[1]);
  });
  for (const name of ["setAttributeNode", "setAttributeNodeNS"]) {
    instrumentMethod(elementPrototype, name, () => false, (receiver, args) => {
      const attribute = args[0];
      captureAttributeState(receiver, attribute instanceof Attr ? attribute.name : undefined);
    });
  }
  const attrPrototype = Attr.prototype;
  instrumentSetter(attrPrototype, "value", () => false, (receiver) => {
    if (receiver instanceof Attr) captureAttributeState(receiver.ownerElement, receiver.name);
  });
  const htmlElementPrototype = HTMLElement.prototype;
  instrumentSetter(htmlElementPrototype, "hidden", () => false, (receiver) => {
    if (receiver instanceof Element) captureExactLoaderState(receiver, "other", "hidden");
  });
  const tokenListPrototype = DOMTokenList.prototype;
  const isOwnedLoaderTokenList = (receiver: unknown): boolean =>
    [...controller.querySelectorAll(loaderSelector)].some((loader) => loader.classList === receiver);
  for (const name of ["add", "remove", "replace", "toggle"]) {
    instrumentMethod(tokenListPrototype, name, () => false, (receiver) => {
      if (!isOwnedLoaderTokenList(receiver)) return;
      const loader = [...controller.querySelectorAll(loaderSelector)]
        .find((candidate) => candidate.classList === receiver);
      if (loader !== undefined) captureExactLoaderState(loader, "class", "class");
    });
  }
  instrumentSetter(tokenListPrototype, "value", () => false, (receiver) => {
    if (!isOwnedLoaderTokenList(receiver)) return;
    const loader = [...controller.querySelectorAll(loaderSelector)]
      .find((candidate) => candidate.classList === receiver);
    if (loader !== undefined) captureExactLoaderState(loader, "class", "class");
  });
  const linkPrototype = (globalThis as unknown as {
    HTMLLinkElement?: { prototype: object };
  }).HTMLLinkElement?.prototype;
  for (const name of ["disabled", "href", "media", "rel"]) {
    instrumentSetter(linkPrototype, name);
  }
  if ("adoptedStyleSheets" in document) {
    const priorOwnDescriptor = Object.getOwnPropertyDescriptor(document, "adoptedStyleSheets");
    let owner: object | null = document;
    let descriptor: PropertyDescriptor | undefined;
    while (owner !== null && descriptor === undefined) {
      descriptor = Object.getOwnPropertyDescriptor(owner, "adoptedStyleSheets");
      owner = Object.getPrototypeOf(owner) as object | null;
    }
    if (descriptor?.get === undefined || descriptor.set === undefined ||
        !Object.isExtensible(document)) {
      state.instrumentationComplete = false;
    } else {
      const getter = descriptor.get;
      const setter = descriptor.set;
      try {
        Object.defineProperty(document, "adoptedStyleSheets", {
          configurable: true,
          enumerable: descriptor.enumerable ?? true,
          get() {
            const value = getter.call(document) as CSSStyleSheet[];
            adoptedCollections.add(value);
            return value;
          },
          set(value: CSSStyleSheet[]) {
            invalidateStyleContext();
            setter.call(document, value);
            adoptedCollections.add(value);
          },
        });
        restorers.push(() => {
          if (priorOwnDescriptor === undefined) {
            delete (document as unknown as Record<string, unknown>).adoptedStyleSheets;
          } else {
            Object.defineProperty(document, "adoptedStyleSheets", priorOwnDescriptor);
          }
        });
      } catch {
        state.instrumentationComplete = false;
      }
    }
  }
  const adoptedCollections = new WeakSet<object>();
  if ("adoptedStyleSheets" in document) adoptedCollections.add(document.adoptedStyleSheets);
  for (const name of ["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"]) {
    instrumentMethod(Array.prototype, name, (receiver) =>
      typeof receiver === "object" && receiver !== null && adoptedCollections.has(receiver)
    );
  }
  state.restoreInstrumentation = () => {
    while (restorers.length > 0) restorers.pop()?.();
  };
  const observe = () => {
    if (!state.frozen && !state.settled) state.observer?.observe(document.documentElement, observerOptions);
  };
  state.observer = new MutationObserver((records) => {
    if (!state.clicked) return;
    const consumedExactRecords = new Set<MutationRecord>();
    for (const record of records) {
      if (record.type !== "attributes" || !(record.target instanceof Element)) continue;
      const captures = exactAttributeCaptures.get(record.target);
      const expected = captures?.[0];
      if (expected === undefined || expected.name !== record.attributeName ||
          expected.oldValue !== record.oldValue) continue;
      captures?.shift();
      if (captures?.length === 0) exactAttributeCaptures.delete(record.target);
      consumedExactRecords.add(record);
    }
    const hasStyleDependentEvidence = [...state.activeBusy.values()].some(
      (active) => active.styleDependent,
    ) || state.settledPairs.some((pair) => pair.styleDependent);
    const localStructureChanged = (record: MutationRecord, target: Element): boolean =>
      localStructureCanAffectLoader && [...loaderStates.keys()].some((loader) => {
        for (let current: Element | null = loader; current !== null; current = current.parentElement) {
          if (record.type === "childList" &&
              (target === current || target === current.parentElement)) return true;
          if (record.type === "attributes" &&
              (target === current || target.parentElement === current.parentElement)) return true;
          if (current === controller) break;
        }
        return false;
      });
    const styleContextChanged = hasStyleDependentEvidence && records.some((record) => {
      const target = record.target instanceof Element
        ? record.target
        : record.target.parentElement;
      if (target === null) return globalStructureCanAffectLoader;
      if (record.type === "attributes" && target === controller &&
          record.attributeName === "aria-busy") return false;
      if (record.type === "attributes" && target.matches(loaderSelector) &&
          controller.contains(target) &&
          ["class", "hidden", "aria-hidden", "style"].includes(
            record.attributeName ?? "",
          )) return false;
      if (target.matches("style, link[rel~=stylesheet]")) return true;
      if (record.type === "attributes" && [...loaderStates.keys()].some((loader) =>
        target !== loader && target.contains(loader)
      )) return true;
      return globalStructureCanAffectLoader || localStructureChanged(record, target);
    });
    if (styleContextChanged) {
      invalidateStyleContext();
    }
    if (sampleStyleContext() !== armedStyleContextToken) invalidateStyleContext();
    for (const [recordIndex, record] of records.entries()) {
      if (record.type === "attributes" && record.target === controller &&
          record.attributeName === "aria-busy") {
        if (record.oldValue === "true") {
          recordLoaderTransition(controller, true, false, "other");
        } else if (controller.getAttribute("aria-busy") === "true" ||
            records.slice(recordIndex + 1).some((later) =>
              later.type === "attributes" && later.target === controller &&
              later.attributeName === "aria-busy" && later.oldValue === "true"
            )) {
          recordLoaderTransition(controller, false, true, "other");
        }
      }
      if (record.type === "childList") {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const added = [node, ...node.querySelectorAll(loaderSelector)]
            .filter((element) => element.matches(loaderSelector) &&
              !element.hasAttribute("data-hunt-render-probe"));
          for (const loader of added) {
            register(loader);
            if (visible(loader)) {
              recordLoaderTransition(
                loader, false, true, "other", sampleStyleContext(), true,
              );
            }
          }
        }
        for (const node of record.removedNodes) {
          if (!(node instanceof Element)) continue;
          const removed = [node, ...node.querySelectorAll(loaderSelector)]
            .filter((element) => element.matches(loaderSelector) &&
              !element.hasAttribute("data-hunt-render-probe"));
          for (const loader of removed) {
            if (loaderStates.get(loader)?.visible === true) {
              recordLoaderTransition(
                loader, true, false, "other", sampleStyleContext(), true,
              );
            }
          }
          removed.forEach((loader) => loaderStates.delete(loader));
        }
      }
      if (record.type === "attributes" && record.target instanceof Element &&
          record.target.matches(loaderSelector) && controller.contains(record.target) &&
          ["class", "hidden", "aria-hidden", "style"].includes(record.attributeName ?? "")) {
        const loader = record.target;
        const known = loaderStates.get(loader) ?? {
          attributes: attributes(loader),
          visible: visible(loader),
        };
        const name = record.attributeName;
        if (consumedExactRecords.has(record)) {
          known.attributes = attributes(loader);
          known.visible = visible(loader);
          loaderStates.set(loader, known);
          continue;
        }
        const key = name === "aria-hidden" ? "ariaHidden"
          : name === "class" ? "className"
          : name as keyof LoaderAttributes;
        const related = records.slice(recordIndex).filter((candidate) =>
          candidate.type === "attributes" && candidate.target === loader &&
          candidate.attributeName === name && !consumedExactRecords.has(candidate)
        );
        if (related.length > 1) {
          known.attributes = attributes(loader);
          known.visible = visible(loader);
          loaderStates.set(loader, known);
          continue;
        }
        const nextValue = loader.getAttribute(name ?? "");
        known.attributes = { ...known.attributes, [key]: nextValue };
        const nextVisible = visible(loader);
        const styleToken = sampleStyleContext();
        recordLoaderTransition(
          loader,
          known.visible,
          nextVisible,
          name === "class" ? "class" : "other",
          styleToken,
          true,
        );
        known.visible = nextVisible;
        loaderStates.set(loader, known);
      }
    }
    syncWitnessState();
  });
  observe();
  globalState.__huntWorkdayNavigationAction = state;
  return true;
}
export function readNavigationActionBusySeen(actionId: string): boolean {
  const globalState = globalThis as unknown as Record<string, unknown>;
  const state = globalState.__huntWorkdayNavigationAction as {
    actionId?: string;
    controller?: HTMLElement;
    clicked?: boolean;
    busySeen?: boolean;
  } | undefined;
  return state?.actionId === actionId && state.clicked === true &&
    state.busySeen === true && state.controller?.isConnected === true;
}
export function freezeNavigationWitness(actionId: string): boolean {
  const globalState = globalThis as unknown as Record<string, unknown>;
  const state = globalState.__huntWorkdayNavigationAction as {
    actionId?: string;
    observer?: MutationObserver;
    frozen?: boolean;
    activeBusy?: Map<object, unknown>;
    settledPairs?: {
      readonly styleDependent?: boolean;
      readonly styleContextToken?: string;
    }[];
    armedStyleContextToken?: string;
    sampleStyleContext?: () => string | undefined;
    syncWitnessState?: () => void;
  } | undefined;
  if (state?.actionId !== actionId) return false;
  const hasStyleDependentPair = state.settledPairs?.some(
    (pair) => pair.styleDependent === true,
  ) === true;
  const freezeStyleContextToken = !hasStyleDependentPair
    ? undefined
    : state.sampleStyleContext?.();
  state.settledPairs = state.settledPairs?.filter((pair) =>
    pair.styleDependent !== true || (
      freezeStyleContextToken !== undefined &&
      state.armedStyleContextToken !== undefined &&
      freezeStyleContextToken === state.armedStyleContextToken &&
      pair.styleContextToken !== undefined &&
      pair.styleContextToken === freezeStyleContextToken
    )
  );
  state.syncWitnessState?.();
  const witnessed = (state as { settled?: boolean }).settled === true &&
    state.activeBusy?.size === 0 &&
    globalState.__huntWorkdayNavigationWitness === actionId;
  state.observer?.disconnect();
  (state as { restoreInstrumentation?: () => void }).restoreInstrumentation?.();
  state.frozen = true;
  return witnessed;
}
export function markNavigationWitnessClicked(actionId: string): void {
  const globalState = globalThis as unknown as Record<string, unknown>;
  const state = globalState.__huntWorkdayNavigationAction as {
    actionId?: string;
    clicked?: boolean;
  } | undefined;
  if (state?.actionId === actionId) state.clicked = true;
}
