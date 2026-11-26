sap.ui.define([
  "sap/m/VBox",
  "sap/m/HBox",
  "sap/m/Text",
  "sap/m/Title",
  "sap/m/Table",
  "sap/m/Column",
  "sap/m/ColumnListItem",
  "sap/m/ObjectStatus",
  "sap/m/FormattedText",
  "sap/m/MessageStrip",
  "sap/m/Button",
  "sap/ui/core/format/DateFormat"
], function (VBox, HBox, Text, Title, Table, Column, ColumnListItem, ObjectStatus, FormattedText, MessageStrip, Button, DateFormat) {
  "use strict";

  var fmtDateTime = DateFormat.getDateTimeInstance({ style: "medium" });

  // ------------------------------------------------------------------ Markdown helpers
  var LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  /** Escapes first, then re-applies the few inline styles the AI answer uses. */
  function inline(text) {
    var links = [];
    var work = String(text == null ? "" : text).replace(LINK, function (match, label, url) {
      links.push('<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(label) + "</a>");
      return "\u0000" + (links.length - 1) + "\u0000";
    });
    work = escapeHtml(work)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    return work.replace(/\u0000(\d+)\u0000/g, function (match, index) { return links[Number(index)] || ""; });
  }

  /** Plain text for controls that cannot render HTML (Text, ObjectStatus). */
  function plain(text) {
    return String(text == null ? "" : text)
      .replace(LINK, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s*[-*+]\s+/, "")
      .trim();
  }

  function listItems(lines) {
    var items = [];
    var seen = false;
    lines.forEach(function (line) {
      var bullet = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
      if (bullet) {
        items.push(bullet[1].trim());
        seen = true;
      } else if (line.trim() && seen) {
        items[items.length - 1] += " " + line.trim();
      }
    });
    return items.filter(Boolean);
  }

  /** Text before the first bullet (e.g. the cited SAP Help paragraph), as inline HTML. */
  function leadHtml(lines) {
    var lead = [];
    lines.forEach(function (line) {
      if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) { return; }
      if (line.trim()) { lead.push(line.trim()); }
    });
    return lead.length ? "<p>" + inline(lead.join(" ")) + "</p>" : "";
  }

  // ------------------------------------------------------------------ Section parsing
  var OVERVIEW_LABELS = {
    "job name": "Job name",
    "message type": "Message type",
    "business purpose": "Business purpose",
    "related sap application": "Related SAP application",
    "direction / partners": "Direction / partners",
    "direction": "Direction",
    "partners": "Partners",
    "idoc type": "IDoc type",
    "status": "Status",
    "system": "System",
    "application": "Application"
  };

  var ROOT_CAUSE_FIELDS = [
    { key: "why", label: /why (it )?happens|^reason$/i },
    { key: "verify", label: /how to verify|how to check|verification/i },
    { key: "resolution", label: /documented resolution|^resolution$|sap documented/i },
    { key: "confidence", label: /confidence/i }
  ];

  function splitSections(markdown) {
    var sections = [{ title: "", lines: [] }];
    String(markdown || "").replace(/\r\n/g, "\n").split("\n").forEach(function (raw) {
      var heading = /^\s{0,3}(#{1,6})\s*(.*)$/.exec(raw.replace(/\s+$/, ""));
      if (heading) {
        sections.push({ title: plain(heading[2]), lines: [] });
      } else {
        sections[sections.length - 1].lines.push(raw.replace(/\s+$/, ""));
      }
    });
    return sections;
  }

  function classify(title) {
    var text = String(title || "").toLowerCase();
    if (/overview|summary/.test(text)) { return "overview"; }
    if (/documented/.test(text)) { return "documented"; }
    if (/root cause|causes|hypothes/.test(text)) { return "rootCauses"; }
    if (/investigation|steps|next step|recommend/.test(text)) { return "steps"; }
    return "other";
  }

  function parseOverview(lines) {
    var pairs = [];
    lines.forEach(function (line) {
      var text = line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();
      if (!text) { return; }
      var pair = /^([^:]{2,60}):\s*(.*)$/.exec(text);
      if (!pair) {
        if (pairs.length) { pairs[pairs.length - 1].value += " " + plain(text); }
        return;
      }
      var label = plain(pair[1]).replace(/\*+/g, "").trim();
      var key = label.toLowerCase();
      pairs.push({ label: OVERVIEW_LABELS[key] || label, value: plain(pair[2]) || "\u2014" });
    });
    return pairs;
  }

  function parseRootCauses(lines) {
    var causes = [];
    var current = null;
    var lastField = null;

    function flush() {
      if (current && (current.title || current.why || current.resolution)) { causes.push(current); }
      current = null;
      lastField = null;
    }

    function start(title) {
      flush();
      current = { title: plain(title), why: "", verify: "", resolution: "", confidence: "" };
    }

    lines.forEach(function (raw) {
      var text = raw.trim();
      if (!text) { return; }
      if (/^-{3,}$/.test(text)) { flush(); return; }

      var numbered = /^\d+\.\s+(.*)$/.exec(text);
      if (numbered) {
        var boldTitle = /^\*\*(.+?)\*\*\s*[:\-]?\s*(.*)$/.exec(numbered[1]);
        start(boldTitle ? boldTitle[1] : numbered[1]);
        if (boldTitle && boldTitle[2]) { current.why = plain(boldTitle[2]); lastField = "why"; }
        return;
      }

      var fieldLine = /^\s*(?:[-*+]\s+)?([^:]{3,60}):\s*(.*)$/.exec(text);
      if (fieldLine) {
        var fieldKey = null;
        ROOT_CAUSE_FIELDS.forEach(function (field) { if (field.label.test(fieldLine[1])) { fieldKey = field.key; } });
        if (fieldKey) {
          if (!current) { start(""); }
          current[fieldKey] = plain(fieldLine[2]) || "\u2014";
          lastField = fieldKey;
          return;
        }
      }

      // "Description:" on its own is a caption for the numbered causes, not a cause itself.
      if (/^description\s*:?\s*$/i.test(text)) { flush(); return; }

      // "Description: <cause>" (or "Cause: <cause>") starts a new cause with that title.
      var described = /^\s*(?:[-*+]\s+)?(?:\*\*)?(?:description|cause|root cause)(?:\*\*)?\s*:\s*(.+)$/i.exec(text);
      if (described) {
        start(described[1].replace(/^\*\*(.+?)\*\*$/, "$1"));
        return;
      }

      // A bold line that is not one of the known fields starts a new cause.
      var boldLine = /^\*\*(.+?)\*\*:?\s*(.*)$/.exec(text);
      if (boldLine) {
        start(boldLine[1]);
        if (boldLine[2]) { current.why = plain(boldLine[2]); lastField = "why"; }
        return;
      }

      if (current && lastField) {
        current[lastField] += " " + plain(text);
      } else if (current && !current.title) {
        current.title = plain(text);
      } else if (current) {
        current.why = (current.why ? current.why + " " : "") + plain(text);
        lastField = "why";
      } else {
        start(text);
      }
    });

    flush();
    return causes;
  }

  /**
   * Turns the AI Markdown into displayable blocks. Anything unrecognised stays as formatted
   * Markdown, so answers in an older shape still render readably.
   */
  function parse(markdown) {
    var result = { overview: [], documented: [], documentedLead: "", rootCauses: [], steps: [], other: [] };
    var source = String(markdown || "").trim();
    if (!source) { return result; }

    splitSections(source).forEach(function (section) {
      var kind = classify(section.title);
      if (kind === "overview") {
        result.overview = result.overview.concat(parseOverview(section.lines));
      } else if (kind === "documented") {
        result.documented = result.documented.concat(listItems(section.lines));
        result.documentedLead = leadHtml(section.lines) || result.documentedLead;
      } else if (kind === "rootCauses") {
        result.rootCauses = result.rootCauses.concat(parseRootCauses(section.lines));
      } else if (kind === "steps") {
        result.steps = result.steps.concat(listItems(section.lines));
      } else {
        var body = section.lines.join("\n").trim();
        if (body) {
          result.other.push({ title: section.title, html: body.split(/\n{2,}/).map(function (chunk) { return "<p>" + inline(chunk).replace(/\n/g, "<br>") + "</p>"; }).join("") });
        }
      }
    });

    // An answer with no headings at all: treat bullet lists as steps.
    if (!result.overview.length && !result.rootCauses.length && !result.steps.length && result.other.length) {
      var loose = listItems(source.split("\n"));
      if (loose.length > 1) {
        result.steps = loose;
        result.other = [];
      }
    }
    return result;
  }

  function confidenceState(value) {
    var text = String(value || "").toLowerCase();
    if (/high|strong|very|\b(8\d|9\d)\b/.test(text)) { return "Success"; }
    if (/medium|moderate|\b(5\d|6\d|7\d)\b/.test(text)) { return "Warning"; }
    if (/low|weak|uncertain|\b([1-4]\d)\b/.test(text)) { return "Error"; }
    return "Information";
  }

  function hasContent(parsed) {
    return !!(parsed.overview.length || parsed.documented.length || parsed.documentedLead || parsed.rootCauses.length || parsed.steps.length || parsed.other.length);
  }

  function formatStamp(value) {
    if (!value) { return ""; }
    var date = value instanceof Date ? value : new Date(value);
    return isNaN(date.getTime()) ? "" : fmtDateTime.format(date);
  }

  // ------------------------------------------------------------------ Control
  /**
   * AI analysis of one failed job run, shown inline on the object page (same table layout as the
   * IDoc analysis): Overview, Most Likely Root Causes, Documented Failure Causes, Recommended
   * Investigation Steps and the corrective steps colleagues saved for earlier failures of the same job.
   * When a run is opened without a stored analysis, the analysis is generated automatically.
   */
  return VBox.extend("job.monitor.ext.ai.AiAnalysis", {
    metadata: {
      properties: {
        analysis: { type: "string", defaultValue: "" },
        analyzedAt: { type: "any", defaultValue: null },
        disclaimer: { type: "string", defaultValue: "" },
        manualCorrections: { type: "object", defaultValue: null },
        jobName: { type: "string", defaultValue: "" },
        sourceKey: { type: "string", defaultValue: "" },
        autoGenerate: { type: "boolean", defaultValue: true },
        showGenerate: { type: "boolean", defaultValue: true },
        generateText: { type: "string", defaultValue: "Regenerate AI Analysis" },
        busy: { type: "boolean", defaultValue: false },
        emptyText: { type: "string", defaultValue: "No AI analysis available for this job run yet." }
      },
      events: {
        generate: {}
      }
    },

    init: function () {
      VBox.prototype.init.apply(this, arguments);
      this.addStyleClass("aiAnalysis");
      this._autoDone = {};
      this._error = "";
      this._rebuild();
    },

    setAnalysis: function (value) { this.setProperty("analysis", value, true); this._rebuild(); this._scheduleAuto(); return this; },
    setAnalyzedAt: function (value) { this.setProperty("analyzedAt", value, true); this._rebuild(); return this; },
    setManualCorrections: function (value) { this.setProperty("manualCorrections", value, true); this._rebuild(); return this; },
    setBusy: function (value) { this.setProperty("busy", value, true); this._rebuild(); return this; },
    setShowGenerate: function (value) { this.setProperty("showGenerate", value, true); this._rebuild(); return this; },
    setJobName: function (value) { this.setProperty("jobName", value, true); this._loadCorrections(); return this; },

    setSourceKey: function (value) {
      var changed = value !== this.getSourceKey();
      this.setProperty("sourceKey", value, true);
      if (changed) {
        this._error = "";
        this.setProperty("manualCorrections", null, true);
        this._rebuild();
      }
      this._loadCorrections();
      this._scheduleAuto();
      return this;
    },

    // ---------------------------------------------------------------- data
    /** Corrections saved for earlier failures of the same job (not this run). */
    _loadCorrections: function () {
      var that = this;
      var model = this.getModel();
      var jobName = this.getJobName();
      var key = this.getSourceKey();
      if (!model || !jobName || !key) { return; }
      var token = jobName + "\u0000" + key;
      if (this._correctionsToken === token) { return; }
      this._correctionsToken = token;

      var call = model.bindContext("/getSimilarCorrections(...)");
      call.setParameter("jobName", jobName);
      call.setParameter("excludeKey", key);
      call.execute().then(function () {
        if (that._correctionsToken !== token) { return; }
        var result = call.getBoundContext().getObject() || {};
        var list = Array.isArray(result.value) ? result.value : (Array.isArray(result) ? result : []);
        that.setManualCorrections(list);
      }).catch(function () {
        if (that._correctionsToken === token) { that._correctionsToken = null; }
      }).finally(function () { call.destroy(); });
    },

    /** Generates the analysis once per run when the run is opened and none is stored yet. */
    _scheduleAuto: function () {
      var that = this;
      if (this._autoTimer) { clearTimeout(this._autoTimer); }
      this._autoTimer = setTimeout(function () {
        that._autoTimer = null;
        var key = that.getSourceKey();
        if (!that.getAutoGenerate() || !key || that.getAnalysis() || that._running || that._autoDone[key]) { return; }
        if (!that.getModel() || !that.getBindingContext()) { return; }
        that._autoDone[key] = true;
        that._runAnalysis();
      }, 0);
    },

    _onGenerate: function () {
      if (this.hasListeners("generate")) { this.fireEvent("generate"); return; }
      this._runAnalysis();
    },

    /** Calls analyzeRunWithAI for the run on the page and shows the stored result inline. */
    _runAnalysis: function () {
      var that = this;
      var model = this.getModel();
      var context = this.getBindingContext();
      var key = this.getSourceKey() || (context && context.getProperty("sourceRunKey"));
      if (!model || !key || this._running) { return; }
      this._running = true;
      this._error = "";
      this.setBusy(true);

      var action = model.bindContext("/analyzeRunWithAI(...)");
      action.setParameter("sourceRunKey", key);
      action.execute().then(function () {
        if (that.getSourceKey() !== key) { return; }
        var result = action.getBoundContext().getObject() || {};
        that.setProperty("analysis", result.aiAnalysis || "", true);
        that.setProperty("analyzedAt", result.aiAnalyzedAt || null, true);
        // Keep the page's own copy of the run in sync, so a later refresh does not show stale data.
        try {
          if (context && context.requestSideEffects) {
            context.requestSideEffects([{ $PropertyPath: "aiAnalysis" }, { $PropertyPath: "aiAnalyzedAt" }])
              .catch(function () { /* already shown */ });
          }
        } catch (e) { /* already shown */ }
      }).catch(function (error) {
        if (that.getSourceKey() === key) { that._error = (error && error.message) || "AI analysis failed."; }
      }).finally(function () {
        that._running = false;
        action.destroy();
        that.setBusy(false);
      });
    },

    // ---------------------------------------------------------------- rendering
    _rebuild: function () {
      if (!this._autoDone) { return; }
      var parsed = parse(this.getAnalysis());
      var showContent = hasContent(parsed);
      var busy = !!this.getBusy();

      this.destroyItems();

      if (busy) {
        this.addItem(new MessageStrip({
          text: showContent ? "Regenerating the analysis from official SAP documentation\u2026" : "Generating the AI analysis from official SAP documentation\u2026",
          type: "Information", showIcon: true, customIcon: "sap-icon://ai"
        }).addStyleClass("aiDisclaimer"));
      }
      if (this._error) {
        this.addItem(new MessageStrip({ text: this._error, type: "Error", showIcon: true }).addStyleClass("aiDisclaimer"));
      }

      if (showContent) {
        if (parsed.overview.length) { this.addItem(this._section("Overview", this._overviewTable(parsed.overview))); }
        if (parsed.rootCauses.length) { this.addItem(this._section("Most Likely Root Causes", this._rootCauseTable(parsed.rootCauses))); }
        if (parsed.documented.length || parsed.documentedLead) { this.addItem(this._section("Documented Failure Causes", this._documented(parsed))); }
        if (parsed.steps.length) { this.addItem(this._section("Recommended Investigation Steps", this._bullets(parsed.steps, true))); }
        parsed.other.forEach(function (chunk) {
          this.addItem(this._section(chunk.title || "Further Details", new FormattedText({ htmlText: chunk.html }).addStyleClass("aiRichText")));
        }.bind(this));
      } else if (!busy && !this._error) {
        this.addItem(new MessageStrip({ text: this.getEmptyText(), type: "Information", showIcon: true }).addStyleClass("aiDisclaimer"));
      }

      var corrections = Array.isArray(this.getManualCorrections()) ? this.getManualCorrections() : [];
      if (corrections.length) {
        this.addItem(this._section("Corrective Steps Taken To Resolve Similar Job Failure In Past", this._correctionsTable(corrections)));
      }

      this.addItem(this._footer(showContent, busy));
    },

    _footer: function (showContent, busy) {
      var items = [new Text({ text: this._metaText(showContent) }).addStyleClass("aiMeta")];
      if (this.getShowGenerate()) {
        items.push(new Button({
          text: showContent ? this.getGenerateText() : "Generate AI Analysis",
          type: "Emphasized",
          icon: "sap-icon://ai",
          busy: busy,
          busyIndicatorDelay: 0,
          enabled: !busy,
          press: this._onGenerate.bind(this)
        }).addStyleClass("aiGenerateButton"));
      }
      return new HBox({ justifyContent: "SpaceBetween", alignItems: "Center", wrap: "Wrap", items: items }).addStyleClass("aiFooter");
    },

    _metaText: function (showContent) {
      var parts = [];
      var stamp = formatStamp(this.getAnalyzedAt());
      if (stamp) { parts.push("Analyzed " + stamp); }
      if (showContent) { parts.push("AI-generated from official SAP documentation. Validate before applying changes."); }
      return parts.join(" \u00b7 ");
    },

    _section: function (title, control) {
      return new VBox({
        items: [
          new Title({ text: title, level: "H4", wrapping: true }).addStyleClass("aiSectionTitle"),
          control
        ]
      }).addStyleClass("aiSection");
    },

    _bullets: function (items, ordered) {
      var tag = ordered ? "ol" : "ul";
      var html = "<" + tag + ">" + items.map(function (item) { return "<li>" + inline(item) + "</li>"; }).join("") + "</" + tag + ">";
      return new FormattedText({ htmlText: html }).addStyleClass("aiRichText");
    },

    /** Documented causes: keeps the cited SAP Help paragraph above the bullet list. */
    _documented: function (parsed) {
      var html = (parsed.documentedLead || "")
        + (parsed.documented.length ? "<ul>" + parsed.documented.map(function (item) { return "<li>" + inline(item) + "</li>"; }).join("") + "</ul>" : "");
      return new FormattedText({ htmlText: html }).addStyleClass("aiRichText");
    },

    /** Corrections saved by colleagues for earlier failures of the same job, newest first. */
    _correctionsTable: function (rows) {
      var table = new Table({
        mode: "None",
        growing: false,
        showSeparators: "All",
        columns: [
          new Column({ width: "62%", header: new Text({ text: "Corrective Steps Taken" }) }),
          new Column({ width: "18%", header: new Text({ text: "Recorded By" }) }),
          new Column({ width: "20%", header: new Text({ text: "Recorded On" }) })
        ]
      }).addStyleClass("aiTable aiCorrectionTable");

      rows.forEach(function (row) {
        table.addItem(new ColumnListItem({
          cells: [
            new FormattedText({ htmlText: inline(String(row.correctionText || "")).replace(/\n/g, "<br>") }).addStyleClass("aiCorrectionText"),
            new Text({ text: row.modifiedBy || row.createdBy || "\u2014", wrapping: true }),
            new Text({ text: formatStamp(row.modifiedAt || row.createdAt) || "\u2014", wrapping: true })
          ]
        }));
      });
      return table;
    },

    _overviewTable: function (pairs) {
      var table = new Table({
        mode: "None",
        growing: false,
        showSeparators: "Inner",
        columns: [
          new Column({ width: "22%", header: new Text({ text: "Attribute" }) }),
          new Column({ header: new Text({ text: "Value" }) })
        ]
      }).addStyleClass("aiTable aiOverviewTable");

      pairs.forEach(function (pair) {
        table.addItem(new ColumnListItem({
          cells: [
            new Text({ text: pair.label }).addStyleClass("aiKey"),
            new Text({ text: pair.value, wrapping: true })
          ]
        }));
      });
      return table;
    },

    _rootCauseTable: function (causes) {
      var table = new Table({
        mode: "None",
        growing: false,
        showSeparators: "All",
        columns: [
          new Column({ width: "18%", header: new Text({ text: "Most Likely Root Cause" }) }),
          new Column({ width: "24%", header: new Text({ text: "Why It Happens" }) }),
          new Column({ width: "24%", header: new Text({ text: "How To Verify" }) }),
          new Column({ width: "25%", header: new Text({ text: "SAP Documented Resolution" }) }),
          new Column({ width: "9%", header: new Text({ text: "Confidence" }) })
        ]
      }).addStyleClass("aiTable aiRootCauseTable");

      causes.forEach(function (cause, index) {
        table.addItem(new ColumnListItem({
          cells: [
            new Text({ text: cause.title || "Possible cause " + (index + 1), wrapping: true }).addStyleClass("aiCauseTitle"),
            new Text({ text: cause.why || "\u2014", wrapping: true }),
            new Text({ text: cause.verify || "\u2014", wrapping: true }),
            new Text({ text: cause.resolution || "\u2014", wrapping: true }),
            cause.confidence
              ? new ObjectStatus({ text: plain(cause.confidence), state: confidenceState(cause.confidence), inverted: true })
              : new Text({ text: "\u2014" })
          ]
        }));
      });
      return table;
    },

    exit: function () {
      if (this._autoTimer) { clearTimeout(this._autoTimer); }
    }
  });
});
