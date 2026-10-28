import { expect, test, type Locator, type Page } from "@playwright/test";

async function model(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    return JSON.parse(JSON.parse(sessionStorage.getItem("mechanica.tab-recovery")!).scene);
  });
}

async function setup(page: Page, theme: string, studio: boolean, scale: number) {
  await page.addInitScript(settings => localStorage.setItem("mechanica.settings",JSON.stringify(settings)),
    { tour_done:true,theme,studio_mode:studio,font_scale:scale });
  await page.goto("/");
  // Persisted preferences cap at 120%; stress larger text explicitly.
  await page.evaluate(scale => document.documentElement.style.setProperty("--fs", String(scale)), scale);
  expect(await page.evaluate(()=>Number(getComputedStyle(document.documentElement).getPropertyValue("--fs")))).toBe(scale);
  const open = page.getByRole("button", { name:"Open Inspector",exact:true });
  if (await open.isVisible()) await open.click();
}

async function active(page: Page, trigger: Locator) {
  const id = await trigger.getAttribute("aria-activedescendant");
  expect(id).toBeTruthy();
  return page.locator(`[id="${id}"]`).textContent();
}

async function fits(menu: Locator) {
  return menu.evaluate(el => {
    const box = el.getBoundingClientRect();
    return { horizontal:box.left >= 7 && box.right <= innerWidth-7,
      vertical:box.top >= 3 && box.bottom <= innerHeight-3 };
  });
}

for (const [theme,studio,width,scale] of [["light",false,1440,1],["dark",true,390,1.2],["light",true,320,2]] as const) {
  test.describe(`${theme}, Studio=${studio}, ${width}px, scale=${scale}`, () => {
    test.use({ viewport:{width,height:900} });
    test("themed graph and event menus start fresh keyboard searches after commit and cancel",async ({ page },info) => {
      const errors:string[]=[]; page.on("pageerror",error=>errors.push(error.message));
      await page.clock.install(); await setup(page,theme,studio,scale);
      await page.getByRole("tab",{name:"View",exact:true}).click();
      const graph=page.getByRole("combobox",{name:"Graph shown in the dock",exact:true});
      await graph.scrollIntoViewIfNeeded();
      await page.clock.pauseAt(await page.evaluate(()=>Date.now()+1000));
      const initial=await model(page);
      await graph.focus(); await graph.pressSequentially("vel"); await graph.press("Enter");
      await expect(graph).toHaveAttribute("data-value","Velocity");
      await expect(graph).toBeFocused();
      await graph.press("e"); await graph.press("Enter");
      await expect(graph).toHaveAttribute("data-value","Energy");
      await graph.press("v"); await graph.press("Escape");
      await expect(graph).toHaveAttribute("data-value","Energy");
      await graph.press("m"); await graph.press("Enter");
      await expect(graph).toHaveAttribute("data-value","Mom.");
      await graph.press("Enter"); await graph.press("Home");
      expect(await active(page,graph)).toBe("Off");
      await graph.press("End"); expect(await active(page,graph)).toBe("Velocity–time");
      await graph.press("Escape"); await expect(graph).toHaveAttribute("aria-expanded","false");
      await page.clock.runFor(50);
      await page.getByRole("tab",{name:"World",exact:true}).click();
      const rule=page.getByRole("combobox",{name:"Pause playback at event",exact:true});
      await rule.focus(); await rule.press("f"); await rule.press("Enter");
      await expect(rule).toHaveAttribute("data-value","contact");
      await rule.press("a"); await rule.press("Enter");
      await expect(rule).toHaveAttribute("data-value","apex");
      await rule.press("l"); await rule.press("Escape");
      await rule.press("o"); await rule.press("Enter");
      await expect(rule).toHaveAttribute("data-value","");
      expect(await model(page)).toEqual(initial);
      await info.attach("menu-keyboard-results",{body:JSON.stringify({graph:"Mom.",rule:"Off",modelPreserved:true}),contentType:"application/json"});
      expect(errors).toEqual([]);
    });

    test("themed menus fit the viewport and close when their owner leaves view",async ({ page },info) => {
      const errors:string[]=[]; page.on("pageerror",error=>errors.push(error.message));
      await setup(page,theme,studio,scale);
      const initial=await model(page);
      for (const [tab,name] of [["View","Graph shown in the dock"],["World","Pause playback at event"]]) {
        await page.getByRole("tab",{name:tab,exact:true}).click();
        const trigger=page.getByRole("combobox",{name,exact:true});
        await trigger.click();
        const menu=page.getByRole("listbox",{name,exact:true});
        await expect(menu).toBeVisible();
        expect(await trigger.evaluate(el=>el.tagName)).toBe("BUTTON");
        expect((await menu.evaluate(el=>getComputedStyle(el).backgroundColor)).replace(/\s/g,"")).toBe(
          (await menu.evaluate((el,token)=>getComputedStyle(el).getPropertyValue(token).trim(),"--panel")).replace(/\s/g,""));
        expect(await fits(menu)).toEqual({horizontal:true,vertical:true});
        await trigger.press("End");
        await expect(page.locator(`[id="${await trigger.getAttribute("aria-activedescendant")}"]`)).toBeInViewport();
        await page.screenshot({path:info.outputPath(`themed-${tab.toLowerCase()}-menu.png`)});
        await page.setViewportSize({width,height:360});
        const owner=await trigger.evaluate(el=>{
          const panel=document.querySelector("#inspector-panel")!;
          panel.scrollTop=0;
          const box=el.getBoundingClientRect(), clip=panel.getBoundingClientRect();
          return { top:box.top,bottom:box.bottom,clipTop:clip.top,clipBottom:clip.bottom,
            outside:box.top >= clip.bottom || box.bottom <= clip.top };
        });
        await info.attach(`hidden-${tab}-owner`,{body:JSON.stringify(owner),contentType:"application/json"});
        expect(owner.outside).toBe(true);
        await expect(trigger).toHaveAttribute("aria-expanded","false");
        await expect(menu).toBeHidden();
        await trigger.scrollIntoViewIfNeeded(); await trigger.click();
        await expect(menu).toBeVisible();
        expect(await fits(menu)).toEqual({horizontal:true,vertical:true});
        const panelScroll=await page.locator("#inspector-panel").evaluate(el=>el.scrollTop);
        await trigger.press("End");
        await expect(page.locator(`[id="${await trigger.getAttribute("aria-activedescendant")}"]`)).toBeInViewport();
        expect(await page.locator("#inspector-panel").evaluate(el=>el.scrollTop)).toBe(panelScroll);
        await page.setViewportSize({width,height:520});
        // Resize and scroll events settle asynchronously. Inspect ownership and
        // popup bounds together so dismissal cannot race a separate role lookup.
        await expect.poll(()=>trigger.evaluate(el=>{
          const popup=document.getElementById(el.getAttribute("aria-controls")!)!;
          if(el.getAttribute("aria-expanded") !== "true") return popup.hidden;
          const box=el.getBoundingClientRect(), panel=document.querySelector("#inspector-panel")!.getBoundingClientRect();
          const bounds=popup.getBoundingClientRect();
          // Ownership follows the visible anchor centre, matching clipping
          // behavior while an edge is partially scrolled behind the panel.
          const x=box.left+box.width/2, y=box.top+box.height/2;
          return x >= panel.left && x < panel.right && y >= panel.top && y < panel.bottom &&
            bounds.left >= 7 && bounds.right <= innerWidth-7 && bounds.top >= 3 && bounds.bottom <= innerHeight-3;
        })).toBe(true);
        await trigger.press("Escape");
        await page.setViewportSize({width,height:900});
      }
      expect(await model(page)).toEqual(initial); expect(errors).toEqual([]);
    });
  });
}
