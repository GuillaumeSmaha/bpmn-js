'use strict';

var domClasses = require('min-dom/lib/classes'),
    domEvent = require('min-dom/lib/event');

var svgAppend = require('tiny-svg/lib/append'),
    svgAttr = require('tiny-svg/lib/attr'),
    svgClone = require('tiny-svg/lib/clone'),
    svgCreate = require('tiny-svg/lib/create'),
    svgRemove = require('tiny-svg/lib/remove');

var assign = require('lodash/object/assign');

var MINIMAP_POSITION = 'right-top';

var MINIMAP_MARGIN = '20px';

var MINIMAP_DIMENSIONS = {
  width: '320px',
  height: '180px'
};

var MINIMAP_STYLES = {
  position: 'absolute',
  overflow: 'hidden',
  width: MINIMAP_DIMENSIONS.width,
  height: MINIMAP_DIMENSIONS.height,
  background: '#fff',
  border: 'solid 1px #CCC',
  borderRadius: '2px',
  boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
  boxSizing: 'border-box',
  userSelect: 'none',
  '-moz-user-select': 'none'
};

var VIEWPORT_STYLES = {
  fill: 'rgba(255, 116, 0, 0.25)'
};

var CROSSHAIR_CURSOR = 'crosshair';
var DEFAULT_CURSOR = 'inherit';
var MOVE_CURSOR = 'move';

var ZOOM_SMOOTHING = 300;
var MIN_ZOOM = 4;
var MAX_ZOOM = 0.2;

/**
 * A minimap that reflects and lets you navigate the diagram.
 */
function Minimap(canvas, elementRegistry, eventBus) {
  var self = this;

  this._canvas = canvas;
  this._elementRegistry = elementRegistry;
  this._eventBus = eventBus;

  this._init();

  // state is necessary for viewport dragging
  this._state = {
    isDragging: false,
    initialDragPosition: null,
    offsetViewport: null,
    cachedViewbox: null,
    dragger: null,
    svgClientRect: null
  };

  // cursor
  domEvent.bind(this._viewport, 'mouseenter', function() {
    setCursor(self._parent, MOVE_CURSOR);
  }, this);

  domEvent.bind(this._viewport, 'mouseleave', function() {
    setCursor(self._parent, CROSSHAIR_CURSOR);
  }, this);

  domEvent.bind(this._parent, 'mouseenter', function() {
    setCursor(self._parent, CROSSHAIR_CURSOR);
  }, this);

  domEvent.bind(this._parent, 'mouseleave', function() {
    setCursor(self._parent, DEFAULT_CURSOR);
  }, this);

  // set viewbox on click
  domEvent.bind(this._svg, 'click', function(event) {

    if (!self._svgClientRect) {
      self._svgClientRect = self._svg.getBoundingClientRect();
    }

    var diagramPoint = mapMousePositionToDiagramPoint({
      x: event.clientX - self._svgClientRect.left,
      y: event.clientY - self._svgClientRect.top
    }, self._canvas, self._svg);

    setViewboxCenteredAroundPoint(diagramPoint, self._canvas);

    self._update();
  }, this);

  // scroll canvas on drag
  domEvent.bind(this._viewport, 'mousedown', function(event) {

    // add dragger
    var dragger = svgClone(self._viewport);
    svgAppend(self._svg, dragger);

    if (!self._svgClientRect) {
      self._svgClientRect = self._svg.getBoundingClientRect();
    }

    var diagramPoint = mapMousePositionToDiagramPoint({
      x: event.clientX - self._svgClientRect.left,
      y: event.clientY - self._svgClientRect.top
    }, self._canvas, self._svg);

    var viewbox = canvas.viewbox();

    var offsetViewport = getOffsetViewport(diagramPoint, viewbox);

    // init dragging
    assign(self._state, {
      isDragging: true,
      initialDragPosition: {
        x: event.clientX,
        y: event.clientY
      },
      offsetViewport: offsetViewport,
      cachedViewbox: viewbox,
      dragger: dragger
    });

    // hide viewport
    svgAttr(self._viewport, 'visibility', 'hidden');
  }, this);

  domEvent.bind(document, 'mousemove', function(event) {

    if (!self._svgClientRect) {
      self._svgClientRect = self._svg.getBoundingClientRect();
    }

    // set viewbox if dragging active
    if (self._state.isDragging) {
      var diagramPoint = mapMousePositionToDiagramPoint({
            x: event.clientX - self._svgClientRect.left,
            y: event.clientY - self._svgClientRect.top
          }, self._canvas, self._svg),
          viewbox = self._state.cachedViewbox;

      setViewboxCenteredAroundPoint({
        x: diagramPoint.x - self._state.offsetViewport.x,
        y: diagramPoint.y - self._state.offsetViewport.y
      }, self._canvas);

      // update dragger
      svgAttr(self._state.dragger, {
        x: Math.round(diagramPoint.x - (viewbox.width / 2)) - self._state.offsetViewport.x,
        y: Math.round(diagramPoint.y - (viewbox.height / 2)) - self._state.offsetViewport.y
      });
    }
  }, this);

  domEvent.bind(document, 'mouseup', function(event) {

    if (self._state.isDragging) {

      // remove dragger
      svgRemove(self._state.dragger);

      // show viewport
      svgAttr(self._viewport, {
        visibility: 'visible'
      });

      self._update();

      // end dragging
      assign(self._state, {
        isDragging: false,
        initialDragPosition: null,
        offsetViewport: null,
        cachedViewbox: null,
        dragger: null
      });
    }
  }, this);

  domEvent.bind(this._svg, 'wheel', function(event) {

    // stop propagation and handle scroll differently
    event.stopPropagation();

    if (!self._svgClientRect) {
      self._svgClientRect = self._svg.getBoundingClientRect();
    }

    var diagramPoint = mapMousePositionToDiagramPoint({
      x: event.clientX - self._svgClientRect.left,
      y: event.clientY - self._svgClientRect.top
    }, self._canvas, self._svg);

    setViewboxCenteredAroundPoint(diagramPoint, self._canvas);

    var zoom = canvas.zoom();

    canvas.zoom(Math.min(Math.max(zoom - (event.deltaY / ZOOM_SMOOTHING), MAX_ZOOM), MIN_ZOOM));

    self._update();
  });

  domEvent.bind(window, 'resize', function() {
    self._svgClientRect = self._svg.getBoundingClientRect();
  });

  // add shape on shape/connection added
  eventBus.on([ 'shape.added', 'connection.added' ], function(ctx) {
    var element = ctx.element,
        gfx = ctx.gfx;

    var djsVisual = getDjsVisual(gfx);

    self.addElement(element, djsVisual);

    self._update();
  });

  // update on elements changed
  eventBus.on([ 'elements.changed' ], function(ctx) {
    var elements = ctx.elements;

    elements.forEach(function(element) {
      self.removeElement(element);

      var gfx = elementRegistry.getGraphics(element);

      if (gfx) {
        var djsVisual = getDjsVisual(gfx);

        self.addElement(element, djsVisual);
      }
    });

    self._update();
  });

  // update on viewbox changed
  eventBus.on('canvas.viewbox.changed', function() {
    if (!self._state.isDragging) {
      self._update();
    }
  });
}

Minimap.$inject = [ 'canvas', 'elementRegistry', 'eventBus' ];

module.exports = Minimap;

Minimap.prototype._init = function() {
  var canvas = this._canvas,
      container = canvas.getContainer();

  // create parent div
  var parent = this._parent = document.createElement('div');

  domClasses(parent).add('djs-minimap');

  switch (getHorizontalPosition(MINIMAP_POSITION)) {
  case 'left':
    assign(MINIMAP_STYLES, { left: MINIMAP_MARGIN });
    break;
  default:
    assign(MINIMAP_STYLES, { right: MINIMAP_MARGIN });
    break;
  }

  switch (getVerticalPosition(MINIMAP_POSITION)) {
  case 'bottom':
    assign(MINIMAP_STYLES, { bottom: MINIMAP_MARGIN });
    break;
  default:
    assign(MINIMAP_STYLES, { top: MINIMAP_MARGIN });
    break;
  }

  assign(parent.style, MINIMAP_STYLES);

  container.appendChild(parent);

  // create svg
  var svg = this._svg = svgCreate('svg');
  svgAttr(svg, { width: '100%', height: '100%' });
  svgAppend(parent, svg);

  // add groups
  var elementsGroup = this._elementsGroup = svgCreate('g');
  svgAppend(svg, elementsGroup);

  var viewportGroup = this._viewportGroup = svgCreate('g');
  svgAppend(svg, viewportGroup);

  // add viewport
  var viewport = this._viewport = svgCreate('rect');
  domClasses(viewport).add('djs-minimap-viewport');
  svgAttr(viewport, VIEWPORT_STYLES);
  svgAppend(viewportGroup, viewport);

  // prevent drag propagation
  domEvent.bind(parent, 'mousedown', function(event) {
    event.stopPropagation();
  });
};

Minimap.prototype._update = function() {
  var bBox = this._canvas.getDefaultLayer().getBBox();
  var viewbox = this._canvas.viewbox();

  // update viewbox
  if (bBox.width < viewbox.width && bBox.height < viewbox.height) {
    svgAttr(this._svg, {
      viewBox: viewbox.x + ', ' + viewbox.y + ', ' + viewbox.width + ', ' + viewbox.height
    });
  } else {
    svgAttr(this._svg, {
      viewBox: bBox.x + ', ' + bBox.y + ', ' + bBox.width + ', ' + bBox.height
    });
  }

  // update viewport
  svgAttr(this._viewport, {
    x: viewbox.x,
    y: viewbox.y,
    width: viewbox.width,
    height: viewbox.height
  });
};

Minimap.prototype.addElement = function(element, djsVisual) {
  var clone = svgClone(djsVisual);

  svgAttr(clone, { id: element.id });
  svgAppend(this._elementsGroup, clone);

  if (!isConnection(element)) {
    svgAttr(clone, { transform: 'translate(' + element.x + ' ' + element.y + ')' });
  }

  return clone;
};

Minimap.prototype.removeElement = function(element) {
  var node = this._svg.getElementById(element.id);

  if (node) {
    svgRemove(node);
  }
};

function setCursor(node, cursor) {
  node.style.cursor = cursor;
}

function isConnection(element) {
  return element.waypoints;
}

function getHorizontalPosition(position) {
  return getPositions(position).horizontal;
}

function getVerticalPosition(position) {
  return getPositions(position).vertical;
}

function getPositions(position) {

  var split = position.split('-');

  return {
    horizontal: split[0] || 'right',
    vertical: split[1] || 'top'
  };
}

function getDjsVisual(gfx) {
  return [].slice.call(gfx.childNodes).filter(function(childNode) {
    return childNode.getAttribute('class') === 'djs-visual';
  })[0];
}

function getOffsetViewport(diagramPoint, viewbox) {
  var centerViewbox = {
    x: viewbox.x + (viewbox.width / 2),
    y: viewbox.y + (viewbox.height / 2)
  };

  return {
    x: diagramPoint.x - centerViewbox.x,
    y: diagramPoint.y - centerViewbox.y
  };
}

function mapMousePositionToDiagramPoint(position, canvas, svg) {

  // firefox returns 0 for clientWidth and clientHeight
  var boundingClientRect = svg.getBoundingClientRect();

  // take different aspect ratios of default layers bounding box and minimap into account
  var bBox =
    fitAspectRatio(canvas.getDefaultLayer().getBBox(), boundingClientRect.width / boundingClientRect.height);

  // map click position to diagram position
  var diagramX = map(position.x, 0, boundingClientRect.width, bBox.x, bBox.x + bBox.width),
      diagramY = map(position.y, 0, boundingClientRect.height, bBox.y, bBox.y + bBox.height);

  return {
    x: diagramX,
    y: diagramY
  };
}

function setViewboxCenteredAroundPoint(point, canvas) {

  // get cached viewbox to preserve zoom
  var cachedViewbox = canvas.viewbox(),
      cachedViewboxWidth = cachedViewbox.width,
      cachedViewboxHeight = cachedViewbox.height;

  canvas.viewbox({
    x: point.x - cachedViewboxWidth / 2,
    y: point.y - cachedViewboxHeight / 2,
    width: cachedViewboxWidth,
    height: cachedViewboxHeight
  });
}

function fitAspectRatio(bounds, targetAspectRatio) {
  var aspectRatio = bounds.width / bounds.height;

  if (aspectRatio > targetAspectRatio) {

    // height needs to be fitted
    var height = bounds.width * (1 / targetAspectRatio),
        y = bounds.y - ((height - bounds.height) / 2);

    assign(bounds, {
      y: y,
      height: height
    });
  } else if (aspectRatio < targetAspectRatio) {

    // width needs to be fitted
    var width = bounds.height * targetAspectRatio,
        x = bounds.x - ((width - bounds.width) / 2);

    assign(bounds, {
      x: x,
      width: width
    });
  }

  return bounds;
}

function map(x, inMin, inMax, outMin, outMax) {
  var inRange = inMax - inMin,
      outRange = outMax - outMin;

  return (x - inMin) * outRange / inRange + outMin;
}
