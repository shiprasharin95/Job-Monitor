sap.ui.define([
  "sap/m/VBox",
  "sap/m/HBox",
  "sap/m/Toolbar",
  "sap/m/ToolbarSpacer",
  "sap/m/Button",
  "sap/m/TextArea",
  "sap/m/Text",
  "sap/m/Title",
  "sap/m/ObjectStatus",
  "sap/m/MessageStrip",
  "sap/m/FormattedText",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/ui/model/json/JSONModel"
], function (VBox, HBox, Toolbar, ToolbarSpacer, Button, TextArea, Text, Title, ObjectStatus,
  MessageStrip, FormattedText, MessageBox, MessageToast, JSONModel) {
  "use strict";

  var MAX = 5000;

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function richText(value) {
    return escapeHtml(value)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
  }

  /** JSONModel has no setProperties(); set each value so bindings update. */
  function assign(model, values) {
    Object.keys(values).forEach(function (key) { model.setProperty("/" + key, values[key]); });
  }

  var fmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

  function when(value) {
    if (!value) { return ""; }
    var date = value instanceof Date ? value : new Date(value);
    return isNaN(date.getTime()) ? "" : fmt.format(date);
  }

  /**
   * Manual correction of one failed run: the steps the operations team performed to fix it.
   * Stored in HANA via saveManualCorrection and shown again for every run of the same job.
   */
  return VBox.extend("job.monitor.ext.ai.ManualCorrections", {
    metadata: {
      properties: {
        sourceKey: { type: "string", defaultValue: "" },
        jobName: { type: "string", defaultValue: "" },
        objectId: { type: "string", defaultValue: "" },
        system: { type: "string", defaultValue: "" },
        errorText: { type: "string", defaultValue: "" },
        statusText: { type: "string", defaultValue: "" },
        statusState: { type: "string", defaultValue: "Information" }
      }
    },

    init: function () {
      VBox.prototype.init.apply(this, arguments);
      this.addStyleClass("aiAnalysis mcSection");
      this._state = new JSONModel({
        text: "", savedText: "", metaText: "", message: "", messageType: "Information",
        saving: false, similar: []
      });
      this.setModel(this._state, "corr");
      this._build();
      this.attachModelContextChange(this._load, this);
    },

    setSourceKey: function (value) { this.setProperty("sourceKey", value, true); this._load(); return this; },
    setJobName: function (value) { this.setProperty("jobName", value, true); this._load(); return this; },

    setBindingContext: function (context, name) {
      VBox.prototype.setBindingContext.apply(this, arguments);
      this._load();
      return this;
    },

    _build: function () {
      var that = this;

      var toolbar = new Toolbar({
        content: [
          new ObjectStatus({ text: "{corr>/statusText}", state: "{corr>/statusState}", inverted: true }),
          new Text({ text: "{corr>/metaText}" }).addStyleClass("aiCorrectionMeta sapUiSmallMarginBegin"),
          new ToolbarSpacer(),
          new Button({
            text: "Discard changes", icon: "sap-icon://undo", type: "Transparent",
            visible: "{= !!${corr>/savedText} && ${corr>/text} !== ${corr>/savedText} }",
            press: this._onDiscard.bind(this)
          }),
          new Button({
            text: "Delete", icon: "sap-icon://delete", type: "Transparent",
            visible: "{= !!${corr>/savedText} }",
            press: this._onDelete.bind(this)
          }),
          new Button({
            text: "Save correction", type: "Emphasized", icon: "sap-icon://save",
            busy: "{corr>/saving}",
            busyIndicatorDelay: 0,
            // Always active (dark blue); empty or unchanged text is answered with a message on press.
            enabled: "{= !${corr>/saving} }",
            press: this._onSave.bind(this)
          }).addStyleClass("mcSaveButton")
        ]
      }).addStyleClass("mcToolbar");

      var area = new TextArea({
        value: "{corr>/text}",
        valueLiveUpdate: true,
        rows: 8,
        growing: false,
        growingMaxLines: 16,
        width: "100%",
        maxLength: MAX,
        placeholder: "Which steps fixed this failure? Transaction / app, change made, who confirmed it."
      }).addStyleClass("mcTextArea");

      var message = new MessageStrip({
        text: "{corr>/message}", type: "{corr>/messageType}", showIcon: true,
        visible: "{= !!${corr>/message} }"
      }).addStyleClass("sapUiSmallMarginTop");

      var similarTitle = new Title({ text: "Corrections saved for the same job", level: "H4" })
        .addStyleClass("aiSectionTitle sapUiMediumMarginTop");

      var similar = new VBox({
        items: { path: "corr>/similar", templateShareable: false, template: this._card() }
      }).addStyleClass("aiCorrections");

      this.addItem(toolbar);
      this.addItem(area);
      this.addItem(message);
      this.addItem(similarTitle);
      this.addItem(similar);
    },

    _card: function () {
      var head = new HBox({
        wrap: "Wrap", alignItems: "Center",
        items: [
          new ObjectStatus({ text: "Saved correction", state: "Success", inverted: true, icon: "sap-icon://accept" }),
          new Text({ text: "{corr>objectId}" }).addStyleClass("aiCorrectionMeta sapUiSmallMarginBegin"),
          new Text({ text: "{corr>metaText}" }).addStyleClass("aiCorrectionMeta sapUiSmallMarginBegin")
        ]
      }).addStyleClass("aiCorrectionHead");

      var body = new FormattedText({ htmlText: "{corr>htmlText}" }).addStyleClass("aiCorrectionText");

      return new VBox({ items: [head, body] }).addStyleClass("aiCorrectionCard");
    },

    _ready: function () {
      return !!(this.getSourceKey() && this.getBindingContext() && this.getModel());
    },

    _load: function () {
      var that = this;
      if (!this._ready()) { return; }

      var model = this.getModel();
      this._state.setProperty("/message", "");

      var call = model.bindContext("/getManualCorrection(...)");
      call.setParameter("sourceKey", this.getSourceKey());
      call.execute().then(function () {
        var result = call.getBoundContext().getObject() || {};
        var saved = result.correction || null;
        var text = saved && saved.correctionText ? saved.correctionText : "";
        assign(that._state, {
          text: text,
          savedText: text,
          metaText: saved ? that._metaOf(saved) : ""
        });
      }).catch(function () { /* the tab still allows writing a new correction */ })
        .finally(function () { call.destroy(); });

      this._loadSimilar();
    },

    _loadSimilar: function () {
      var that = this;
      if (!this._ready() || !this.getJobName()) { return; }

      var call = this.getModel().bindContext("/getSimilarCorrections(...)");
      call.setParameter("jobName", this.getJobName());
      call.setParameter("excludeKey", this.getSourceKey());
      call.execute().then(function () {
        var result = call.getBoundContext().getObject() || {};
        var list = Array.isArray(result.value) ? result.value : (Array.isArray(result) ? result : []);
        that._state.setProperty("/similar", list.map(function (row) {
          return { objectId: row.objectId, metaText: that._metaOf(row), htmlText: richText(row.correctionText) };
        }));
      }).catch(function () {
        that._state.setProperty("/similar", []);
      }).finally(function () { call.destroy(); });
    },

    _metaOf: function (row) {
      var parts = [];
      var by = row.modifiedBy || row.createdBy;
      if (by) { parts.push(by); }
      var stamp = when(row.modifiedAt || row.createdAt);
      if (stamp) { parts.push(stamp); }
      return parts.join(" \u00b7 ");
    },

    _onSave: function () {
      var text = String(this._state.getProperty("/text") || "").trim();
      if (!text) {
        assign(this._state, { message: "Enter the steps that fixed this failure before saving.", messageType: "Warning" });
        return;
      }
      if (text === String(this._state.getProperty("/savedText") || "").trim()) {
        MessageToast.show("No changes to save");
        return;
      }
      this._write(text, "Correction saved");
    },

    _onDiscard: function () {
      this._state.setProperty("/text", this._state.getProperty("/savedText") || "");
      this._state.setProperty("/message", "");
    },

    _onDelete: function () {
      var that = this;
      MessageBox.confirm("Delete the saved correction of this run?", { title: "Manual Corrections" })
        .then(function (action) {
          if (action === MessageBox.Action.OK) { that._write("", "Correction deleted"); }
        });
    },

    _write: function (text, successMessage) {
      var that = this;
      if (!this._ready()) { return; }

      this._state.setProperty("/saving", true);
      this._state.setProperty("/message", "");

      var call = this.getModel().bindContext("/saveManualCorrection(...)");
      call.setParameter("sourceKey", this.getSourceKey());
      call.setParameter("correctionText", text);
      call.setParameter("objectId", this.getObjectId());
      call.setParameter("category", this.getJobName());
      call.setParameter("system", this.getSystem());
      call.setParameter("errorText", String(this.getErrorText() || "").slice(0, 4000));

      call.execute().then(function () {
        var result = call.getBoundContext().getObject() || {};
        var saved = result.correction || null;
        var savedText = saved && saved.correctionText ? saved.correctionText : "";
        assign(that._state, {
          text: savedText,
          savedText: savedText,
          metaText: saved ? that._metaOf(saved) : "",
          saving: false,
          message: successMessage,
          messageType: "Success"
        });
        that._loadSimilar();
        MessageToast.show(successMessage);
      }).catch(function (error) {
        assign(that._state, {
          saving: false,
          message: error.message || "The correction could not be saved.",
          messageType: "Error"
        });
      }).finally(function () { call.destroy(); });
    },

    exit: function () {
      if (this._state) { this._state.destroy(); }
    }
  });
});
