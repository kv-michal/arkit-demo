#import "SessionAccess.h"
#import <ViroKit/VROViewAR.h>
#import <ViroKit/VROARSessioniOS.h>

@implementation FFSessionAccess
+ (ARSession *)sessionInView:(UIView *)view {
  if ([view isKindOfClass:[VROViewAR class]]) {
    auto session = std::dynamic_pointer_cast<VROARSessioniOS>([(VROViewAR *)view getARSession]);
    if (session) return session->getARSession();
  }
  for (UIView *child in view.subviews) {
    ARSession *session = [self sessionInView:child];
    if (session) return session;
  }
  return nil;
}
+ (ARSession *)currentSession {
  NSAssert([NSThread isMainThread], @"Session access requires the main queue");
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      if (window.hidden) continue;
      ARSession *session = [self sessionInView:window];
      if (session) return session;
    }
  }
  return nil;
}
@end
