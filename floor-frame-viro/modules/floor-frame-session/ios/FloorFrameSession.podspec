Pod::Spec.new do |s|
  s.name           = 'FloorFrameSession'
  s.version        = '1.0.0'
  s.summary        = 'Surface raycasts and anchors on the existing Viro ARKit session'
  s.description    = 'Matches Floor Frame surface sampling without a second renderer or camera.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4',
    :tvos => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'ViroKit'
  s.frameworks = 'ARKit', 'GLKit'
  s.libraries = 'c++'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
