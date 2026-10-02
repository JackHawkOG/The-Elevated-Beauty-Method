import { useEffect } from "react";

export function useGuidePageMeta(title: string, description: string) {
  useEffect(() => {
    const oldTitle = document.title;
    document.title = title;
    const tags: Array<["name" | "property", string, string]> = [
      ["name", "description", description],
      ["property", "og:title", title],
      ["property", "og:description", description],
      ["property", "og:type", "website"],
    ];
    const changes = tags.map(([attribute, key, value]) => {
      let node = document.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
      const created = !node;
      if (!node) {
        node = document.createElement("meta");
        node.setAttribute(attribute, key);
        document.head.appendChild(node);
      }
      const oldValue = node.content;
      node.content = value;
      return { node, created, oldValue };
    });
    return () => {
      document.title = oldTitle;
      for (const { node, created, oldValue } of changes) {
        if (created) node.remove();
        else node.content = oldValue;
      }
    };
  }, [title, description]);
}