import React from 'react';
import { geoPath, geoMercator } from 'd3-geo';
import { toCircle, fromCircle, combine, separate } from 'flubber';
import { interpolateHsl, interpolateNumber } from 'd3-interpolate';
import { scaleLinear } from 'd3-scale';
import TweenMax from 'gsap/TweenMax';
import {
  forceSimulation,
  forceLink,
  forceX,
  forceY,
  forceCollide
} from 'd3-force';
import memoize from 'memoize-one';

const tweenableColors = { fill: true, stroke: true };

const interpolateStyles = (previousStyle, nextStyle) => {
  const pKeys = Object.keys(previousStyle);
  const nKeys = Object.keys(nextStyle);
  const styleKeys = [...pKeys, ...nKeys].reduce(
    (p, c) => (p.indexOf(c) !== -1 ? p : [...p, c]),
    []
  );

  const styleInterpolators = {};

  styleKeys.forEach((styleKey) => {
    if (tweenableColors[styleKey]) {
      if (previousStyle[styleKey] === "none" || nextStyle[styleKey] === "none") {
        styleInterpolators[styleKey] = () => "none"
      }
      else {
        styleInterpolators[styleKey] = interpolateHsl(
          previousStyle[styleKey] || 'white',
          nextStyle[styleKey] || 'white'
        );  
      }
    } else {
      styleInterpolators[styleKey] = interpolateNumber(
        previousStyle[styleKey] || 0,
        nextStyle[styleKey] || 0
      );
    }
  });
  return styleInterpolators;
};

function pointOnArcAtAngle(center, angle, distance) {
  const radians = Math.PI * (angle + 0.75) * 2;

  const xPosition = center[0] + distance * Math.cos(radians);
  const yPosition = center[1] + distance * Math.sin(radians);

  return `${xPosition},${yPosition}`;
}

const generateCirclePath = (cx, cy, r, points = 20) => {
  r = Math.max(r, 0.5);
  const generatedPoints = Array.from(Array(points), (d, i) =>
    pointOnArcAtAngle([cx, cy], i / points, r));
  return `M${generatedPoints.join('L')}Z`;
};

const generateRealCirclePath = (cx, cy, r) =>
  `${[
    'M',
    cx - r,
    cy,
    'a',
    r,
    r,
    0,
    1,
    0,
    r * 2,
    0,
    'a',
    r,
    r,
    0,
    1,
    0,
    -(r * 2),
    0
  ].join(' ')}Z`;

const sizeByWrapper = sizeBy =>
  (typeof sizeBy === 'function' ? sizeBy : d => d[sizeBy]);

  const calculateFeatures = ({ size, projectionType, mapData }) => {
    const features = mapData;

    features.forEach(({ geometry }) => {
      if (geometry.type === 'MultiPolygon') {
        geometry.coordinates = geometry.coordinates.sort((a, b) => b[0].length - a[0].length);
      }
    });

    const extentFeatures = {
      type: 'GeometryCollection',
      geometries: features.map(d => d.geometry)
    };

    const projection = projectionType().fitExtent(
      [[0, 0], size],
      extentFeatures
    );
    const pathGenerator = geoPath().projection(projection);

    const featureEdges = [];


    features.forEach((d, i) => {
      d.centroid = pathGenerator.centroid(d);
      d.geoPath = pathGenerator(d);
      d.x = d.centroid[0];
      d.y = d.centroid[1];

      if (d.geometry.type === 'MultiPolygon') {
        d.geoPath = `M${d.geoPath
          .split('M')
          .filter(d => d.length > 0)
          .sort((a, b) => b.length - a.length)
          .join('M')}`;

        d.geoPathMultiple = d.geoPath.split('M').filter((d, i) => i !== 0);
        d.geoPathMultiple = d.geoPathMultiple.map(gp => `M${gp}`).reverse();
      }

      d.properties.neighbors &&
        d.properties.neighbors.forEach((target) => {
          featureEdges.push({ source: d, target: features[target] });
        });
    });

    return { features,
    featureEdges }
  }

class VisualizationLayer extends React.Component {
  constructor(props) {
    const { size = [500, 500], projectionType = geoMercator, mapData } = props;

    

    super(props);
    this.state = calculateFeatures({ size, projectionType, mapData })
  }

  forceSimulateCartogram = memoize((sizeBy = () => 5, data = [], width = 500, height = 500) => {
    const { features, featureEdges } = this.state;
    const {
      zoomToFit,
      geoStyleFn,
      circleStyleFn,
      numberOfCirclePoints
    } = this.props;

    const size = [width, height]

    const mappedFeatures = features.map((d, i) => {
      const correspondingDataFeature = data.find(p => p.id === d.id);
      const datum = {
        ...d,
        ...correspondingDataFeature
      };

      datum.r = sizeByWrapper(sizeBy)(datum, i);
      return datum;
    });

    const linkForce = forceLink()
      .strength(1)
      .links(featureEdges);

    const circleCollide = forceCollide().radius(d => d.r);
    const dorlingSimulation = forceSimulation()
      .force('link', linkForce)
      .force('x', forceX(d => d.centroid[0]).strength(1))
      .force('y', forceY(d => d.centroid[1]).strength(1))
      .force('collide', circleCollide)
      .nodes(mappedFeatures);

    for (let i = 0; i < 500; ++i) dorlingSimulation.tick();

    const minX = mappedFeatures.reduce(
      (p, c) => Math.min(p, c.x - c.r),
      Infinity
    );
    const minY = mappedFeatures.reduce(
      (p, c) => Math.min(p, c.y - c.r),
      Infinity
    );
    const maxX = mappedFeatures.reduce(
      (p, c) => Math.max(p, c.x + c.r),
      -Infinity
    );
    const maxY = mappedFeatures.reduce(
      (p, c) => Math.max(p, c.y + c.r),
      -Infinity
    );

    const aspectRatio = (maxX - minX) / (maxY - minY);
    // aspectRatio = Math.min(xDifference, yDifference)
    let xRange = [0, size[0]];
    let yRange = [0, size[1]];
    let changeRate;
    if (aspectRatio > 1) {
      changeRate = (xRange[1] - xRange[0]) / (maxX - minX);
      const middle = size[1] / 2;
      const height = ((maxY - minY) / 2) * changeRate;
      yRange = [middle - height, middle + height];
    } else {
      changeRate = (yRange[1] - yRange[0]) / (maxY - minY);
      const middle = size[0] / 2;
      const width = ((maxX - minX) * changeRate) / 2;
      xRange = [middle - width, middle + width];
    }

    const xScale = scaleLinear()
      .domain([minX, maxX])
      .range(xRange);
    const yScale = scaleLinear()
      .domain([minY, maxY])
      .range(yRange);

    mappedFeatures.forEach((d, i) => {
      const circleStyleD = circleStyleFn(d);
      const geoStyleD = geoStyleFn(d);

      if (zoomToFit) {
        d.x = xScale(d.x);
        d.y = yScale(d.y);
        d.r = changeRate * d.r;
      }

      d.circlePath = generateCirclePath(d.x, d.y, d.r, numberOfCirclePoints);
      d.circlePathReal = generateRealCirclePath(d.x, d.y, d.r);
      d.toCartogram = d.geoPathMultiple
        ? combine(d.geoPathMultiple, d.circlePath)
        : toCircle(d.geoPath, d.x, d.y, d.r);

      d.toMap = d.geoPathMultiple
        ? separate(d.circlePath, d.geoPathMultiple)
        : fromCircle(d.x, d.y, d.r, d.geoPath);

      d.toCartogramStyle = interpolateStyles(geoStyleD, circleStyleD);
      d.toMapStyle = interpolateStyles(circleStyleD, geoStyleD);
    });
    return mappedFeatures;
  })

  cartogramOrMap = (morphingDirection = 'toCartogram', features) => {
    const svg = this.svg

    if (morphingDirection === "toMap") {
      svg.querySelectorAll('.react-dorling-cartogram-custom-mark')
      .forEach(node => {
        node.style.display = "none"
        node.style.opacity = 0
        })
    }
    const { transitionSeconds = 1, customMark, customMarkTransition = 0.5 } = this.props;
    const counter = { var: 0 };
    const paths = svg.querySelectorAll('path.cartogram-element');
    const labels = svg.querySelectorAll('.cartogram-label');
    labels &&
      labels.forEach((label, labelI) => {
        const labelFeature = features[labelI];
        const xyCoords =
          morphingDirection === 'toCartogram'
            ? [labelFeature.x, labelFeature.y]
            : labelFeature.centroid;
        TweenMax.to(label, transitionSeconds, {
          x: xyCoords[0],
          y: xyCoords[1]
        });
      });
    TweenMax.to(counter, transitionSeconds, {
      var: 100,
      fill: 'green',
      onUpdate() {
        if (counter.var === 100 && morphingDirection === 'toCartogram') {
          svg.querySelectorAll('.react-dorling-cartogram-custom-mark')
         .forEach(node => {
          node.style.display = "block"
          TweenMax.to(node, customMarkTransition, {
            opacity: 1
          });
          })
        }
        paths.forEach((path, pathI) => {
          if (counter.var === 100 && morphingDirection === 'toMap') {
            path.setAttribute('d', features[pathI].geoPath);
          } else if (
            counter.var === 100 &&
            morphingDirection === 'toCartogram'
          ) {
            path.setAttribute('d', features[pathI].circlePathReal);    
          } else if (features[pathI].geoPathMultiple) {
            path.setAttribute(
              'd',
              features[pathI][morphingDirection]
                .map(d => d(counter.var / 100))
                .join(' ')
            );
          } else {
            path.setAttribute(
              'd',
              features[pathI][morphingDirection](counter.var / 100)
            );
          }
          Object.keys(features[pathI][`${morphingDirection}Style`]).forEach((styleKey) => {
            path.style[styleKey] = features[pathI][
              `${morphingDirection}Style`
            ][styleKey](counter.var / 100);
          });
        });
      }
    });
  }
  componentDidMount() {
    this.props.passVoronoiPoints(this.forceSimulateCartogram(this.props.sizeBy, this.props.data, this.props.size[0], this.props.size[1]));
    if (!this.props.cartogram) {
      this.svg.querySelectorAll('.react-dorling-cartogram-custom-mark')
      .forEach(node => {
        node.style.display = "none"
        node.style.opacity = 0
        })  
    }
  }

  componentWillReceiveProps(nextProps) {
    const { size = [500, 500], projectionType = geoMercator, mapData } = nextProps;

    if (this.props.size[0] !== size[0] || this.props.size[1] !== size[1]) {
      this.setState(calculateFeatures({ size, projectionType, mapData }))
    }

  }

  componentDidUpdate(prevProps) {
    const found = this.state.features.find((d, i) =>
      sizeByWrapper(this.props.sizeBy)(d, i) !==
        sizeByWrapper(prevProps.sizeBy)(d, i))  || this.props.size[0] !== prevProps.size[0] || this.props.size[1] !== prevProps.size[1] || this.props.customMark !== prevProps.customMark

    if (found) {
      this.props.passVoronoiPoints(this.forceSimulateCartogram(this.props.sizeBy, this.props.data, this.props.size[0], this.props.size[1]));
    }
  }

  shouldComponentUpdate(nextProps) {
    const found = this.state.features.find((d, i) =>
      sizeByWrapper(this.props.sizeBy)(d, i) !==
        sizeByWrapper(nextProps.sizeBy)(d, i)) || this.props.size[0] !== nextProps.size[0] || this.props.size[1] !== nextProps.size[1] || this.props.customMark !== nextProps.customMark
    if (found) {
      return true;
    }

    if (nextProps.cartogram !== this.props.cartogram) {
      const direction = nextProps.cartogram ? 'toCartogram' : 'toMap';
      this.cartogramOrMap(
        direction,
        this.forceSimulateCartogram(nextProps.sizeBy, nextProps.data, nextProps.size[0], nextProps.size[1])
      );
      return false;
    }
    return true;
  }

  render() {
    const {
      sizeBy,
      data,
      cartogram,
      geoStyleFn,
      circleStyleFn,
      labelFn,
      onHover,
      showBorders,
      zoomToFit,
      customMark,
      size
    } = this.props;

    const { featureEdges } = this.state;

    const sizedFeatures = this.forceSimulateCartogram(sizeBy, data, size[0], size[1]);

    let hoverEvents = () => {};

    if (onHover) {
      hoverEvents = d => ({
        onMouseEnter: () => onHover(d),
        onMouseLeave: () => onHover()
      });
    }

    return (
      <g className="visualization-layer" ref={ref => (this.svg = ref)}>
        {!zoomToFit &&
          showBorders &&
          featureEdges.map((f, i) => (
            <path
              key={`cartogram-border-line-${i}`}
              d={`M${f.source.x},${f.source.y}L${f.target.x},${f.target.y}`}
            />
          ))}
        {sizedFeatures.map((f, i) => (
          <g key={`cartogram-container-${f.id || i}`}>
          <path
            key={`cartogram-element-${f.id || i}`}
            className="cartogram-element"
            fill="gold"
            d={cartogram ? f.circlePath : f.geoPath}
            style={cartogram ? circleStyleFn(f) : geoStyleFn(f)}
            {...hoverEvents(f)}
          />
          {customMark && <g className="react-dorling-cartogram-custom-mark">{customMark(f,i)}</g>}
          </g>
        ))}
        {labelFn &&
          sizedFeatures.map((f, i) => {
            let label = labelFn && labelFn(f);
            if (typeof label === 'string' || typeof label === 'number') {
              label = (
                <text y={6} textAnchor="middle">
                  {label}
                </text>
              );
            }
            return (
              <g
                key={`cartogram-label-${f.id || i}`}
                className="cartogram-label"
                transform={`translate(${cartogram ? f.x : f.centroid[0]},${
                  cartogram ? f.y : f.centroid[1]
                })`}
              >
                {label}
              </g>
            );
          })}
      </g>
    );
  }
}

export default VisualizationLayer;
